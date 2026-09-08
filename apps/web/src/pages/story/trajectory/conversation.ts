import { useEffect, useMemo } from 'react'
import { useInfiniteQuery, useQueries } from '@tanstack/react-query'
import type { RunRecord } from '../../../../../../packages/rp-core/src/types.ts'
import type { RunTrajectory, StoryTrajectory, TrajectoryRound } from '../../../../../../packages/protocol/src/trace.ts'
import { api } from '../../../lib/api.ts'
import { isActive } from './model.ts'

type Cursor = { before?: number; after?: number; around?: string }
export const traceKey = (runId: string, id: string) => `${runId}/${id}`

/** Never merge stale pages across a delete/edit; attempts share the logical round ID. */
export function conversationRounds(pages: readonly StoryTrajectory[]): TrajectoryRound[] {
  const revision = Math.max(0, ...pages.map(page => page.revision))
  return [...new Map(pages.filter(page => page.revision === revision).flatMap(page => page.rounds).map(round => [round.id, round])).values()].sort((a, b) => a.cursor - b.cursor)
}

export function useConversationTrajectory(storyId: string, recent: RunRecord[], visible: boolean, anchor: string | null, search: string, errors: boolean, deleted = false) {
  const source = useInfiniteQuery({ queryKey: ['story-trajectory', storyId, search, anchor, deleted], enabled: visible,
    initialPageParam: (anchor ? { around: anchor } : {}) as Cursor,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ q: search, deleted: String(deleted) })
      for (const [key, value] of Object.entries(pageParam)) params.set(key, String(value))
      return api<StoryTrajectory>(`/stories/${storyId}/trajectory?${params}`, 'GET', undefined, signal)
    },
    getPreviousPageParam: page => page.beforeCursor === null ? undefined : { before: page.beforeCursor },
    getNextPageParam: page => page.afterCursor === null ? undefined : { after: page.afterCursor },
    refetchInterval: state => visible && (recent.some(run => isActive(run.status)) || state.state.data?.pages.some(page => page.rounds.some(round => round.state === 'active' && isActive(round.trajectory.run.status)))) ? 1000 : false,
  })
  const runSignal = recent.map(run => `${run.id}:${run.status}`).join(',')
  useEffect(() => { if (visible) void source.refetch() }, [visible, runSignal])
  useEffect(() => {
    if (!visible || !(search || errors) || source.isFetching || source.isError) return
    if (source.hasPreviousPage) void source.fetchPreviousPage()
    else if (source.hasNextPage) void source.fetchNextPage()
  }, [visible, search, errors, source.isFetching, source.isError, source.hasPreviousPage, source.hasNextPage, source.data])
  const rounds = useMemo(() => conversationRounds(source.data?.pages ?? []), [source.data])
  const latest = source.data?.pages.reduce<StoryTrajectory | undefined>((latest, page) => !latest || page.revision >= latest.revision ? page : latest, undefined)
  return { ...source, rounds, revision: latest?.revision ?? 0, totalRounds: latest?.totalRounds ?? 0, deletedRounds: latest?.deletedRounds ?? 0, totalItems: latest?.totalItems ?? 0,
    searching: !!(search || errors) && !source.isError && (source.isPending || source.hasPreviousPage || source.hasNextPage) }
}

/** Historical attempts are fetched only when explicitly opened, with their original Writer inputs. */
export function useHistoricalAttempts(rounds: TrajectoryRound[], choices: Record<string, string>, search: string, visible: boolean) {
  const targets = rounds.flatMap(round => {
    const attempt = round.attempts.find(attempt => attempt.runId === choices[round.id])
    return attempt ? [{ round, attempt }] : []
  })
  const queries = useQueries({ queries: targets.map(({ attempt }) => ({ queryKey: ['trajectory-attempt', attempt.runId, search], enabled: visible,
    queryFn: ({ signal }: { signal: AbortSignal }) => api<RunTrajectory>(`/runs/${attempt.runId}/trajectory?q=${encodeURIComponent(search)}`, 'GET', undefined, signal) })) })
  const states = new Map(targets.map(({ round, attempt }, index) => [round.id, { attempt, ...queries[index]! }]))
  return { states, rounds: rounds.map(round => {
    const state = states.get(round.id)
    return state ? { ...round, trajectory: state.data ?? { ...round.trajectory, entries: [], agents: [], requests: [], matches: [] } } : round
  }) }
}
