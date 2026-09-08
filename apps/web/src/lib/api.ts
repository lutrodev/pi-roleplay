import { uiT } from "./i18n.ts"
import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Preferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import type { AssetKind, AssetRecord, ModelRoute, RunRecord, StorySnapshot } from '../../../../packages/rp-core/src/types.ts'
import type { ActiveTool, StoryNotice } from '../../../../packages/protocol/src/reading.ts'
import { StoryFeed } from './story-feed.ts'

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly details?: unknown) { super(message) }
}
export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15000, retry: false, refetchOnWindowFocus: true }, mutations: { retry: false } } })
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch('/api' + path, { method, credentials: 'same-origin', signal,
      headers: body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError(uiT("暂时无法连接服务器，请恢复连接后重试。"), 'NETWORK_ERROR', 0)
  }
  if (response.status === 204) return undefined as T
  const value = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') void queryClient.invalidateQueries({ queryKey: ['auth'] })
    throw new ApiError(value?.error?.message ?? uiT("请求失败（%{v0}），请稍后重试。", { v0: response.status }), value?.error?.code ?? 'HTTP_ERROR', response.status, value?.error?.details)
  }
  if (value === null) throw new ApiError(uiT('服务器返回了无法读取的内容，请重试。'), 'INVALID_RESPONSE', response.status)
  return value as T
}
export interface Settings { revision: number; preferences: Preferences }
export interface ModelInfo extends ModelRoute { label: string; configured: boolean; input: string[]; contextWindow: number; maxTokens: number; thinkingLevels: string[]; defaultThinkingLevel: string; reasoningSource: 'catalog' | 'unknown' | 'manual' }
export type AssetItem = Omit<AssetRecord, 'data' | 'sourceHash'> & { description?: string; contentCharacters?: number | null }
export type StoryData = { story: StorySnapshot; runs: RunRecord[]; activeTools: ActiveTool[]; history: { before: string | null; total: number }; latestReplyId: string | null; forkSourceAvailable?: boolean }
export function notifyStoryDeleted(storyId: string) { window.dispatchEvent(new CustomEvent('rp-story-deleted', { detail: storyId })) }
export function useSettings() { return useQuery({ queryKey: ['settings'], queryFn: ({ signal }) => api<Settings>('/settings', 'GET', undefined, signal) }) }
export function useModels() { return useQuery({ queryKey: ['models'], queryFn: ({ signal }) => api<{ models: ModelInfo[]; effectiveMain: ModelRoute | null }>('/settings/models', 'GET', undefined, signal) }) }
export function useAsset(id: string | undefined) { return useQuery({ queryKey: ['asset', id], enabled: !!id, queryFn: ({ signal }) => api<{ asset: AssetRecord; associatedLorebooks: AssetItem[] }>(`/assets/${encodeURIComponent(id!)}`, 'GET', undefined, signal) }) }
export function useAssetCatalog(kind: AssetKind, q = '', offset = 0) {
  return useQuery({ queryKey: ['assets', kind, q, offset], queryFn: ({ signal }) => api<{ assets: AssetItem[]; total: number; nextOffset: number | null }>(`/assets?kind=${kind}&q=${encodeURIComponent(q)}&offset=${offset}&limit=50`, 'GET', undefined, signal) })
}

export function useAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null)
  const lock = useRef(false)
  const run = async (action: () => Promise<unknown>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(null)
    try { await action() } catch (error) { setError(error instanceof Error ? error : new Error(uiT("操作失败，请重试。"))) }
    finally { lock.current = false; setBusy(false) }
  }
  return { busy, error, run, clear: () => setError(null) }
}

/** Fetch commands have no automatic retries. SSE replays events; fetching a snapshot never reruns a task. */
export function useStory(storyId: string) {
  const client = useQueryClient(), [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting')
  const feed = useMemo(() => new StoryFeed(storyId), [storyId])
  const fetchSnapshot = async (signal: AbortSignal) => feed.snapshot(await api<StoryData>(`/stories/${storyId}`, 'GET', undefined, signal))
  const query = useQuery({ queryKey: ['story', storyId], queryFn: ({ signal }) => fetchSnapshot(signal) })
  const ready = !!query.data
  useEffect(() => { if (ready && query.error instanceof ApiError && query.error.code === 'STORY_NOT_FOUND') notifyStoryDeleted(storyId) }, [ready, query.error, storyId])
  useEffect(() => {
    if (!ready) return
    let closed = false, stream: EventSource | undefined, refresh: ReturnType<typeof setTimeout> | undefined, reconnect: ReturnType<typeof setTimeout> | undefined
    let cursor = client.getQueryData<StoryData>(['story', storyId])!.story.revision
    const stop = () => { closed = true; stream?.close(); clearTimeout(refresh); clearTimeout(reconnect) }
    const deleted = (event: Event) => { if ((event as CustomEvent).detail === storyId) stop() }
    window.addEventListener('rp-story-deleted', deleted)
    const schedule = () => {
      if (refresh) return
      refresh = setTimeout(() => { refresh = undefined; void client.invalidateQueries({ queryKey: ['story', storyId] }); void client.invalidateQueries({ queryKey: ['stories'] }) }, 180)
    }
    const open = () => {
      if (closed) return
      stream = new EventSource(`/api/stories/${storyId}/events?after=${cursor}`)
      stream.onopen = () => setConnection('live')
      stream.addEventListener('story-deleted', () => { if (!closed) { stop(); notifyStoryDeleted(storyId) } })
      stream.addEventListener('story', event => {
        if (closed) return
        const message = event as MessageEvent<string>, record = JSON.parse(message.data) as StoryNotice
        if (record.seq <= cursor) return
        cursor = record.seq
        client.setQueryData<StoryData>(['story', storyId], current => feed.receive(current, record))
        if (record.type === 'message.edited' || record.type === 'messages.removed') { window.dispatchEvent(new CustomEvent('rp-history-changed', { detail: storyId })); void client.resetQueries({ queryKey: ['story-trajectory', storyId] }) }
        if (record.type === 'message.feedback') window.dispatchEvent(new CustomEvent('rp-message-feedback', { detail: { storyId, ...record.data } }))
        if (record.type === 'workspace.changed') { void client.invalidateQueries({ queryKey: ['story-workspace', storyId] }); void client.invalidateQueries({ queryKey: ['workspace', storyId] }); void client.invalidateQueries({ queryKey: ['workspace-preview', storyId] }) }
        if (record.type.startsWith('input.')) void client.invalidateQueries({ queryKey: ['input-queue', storyId] })
        if (record.type === 'model.message') void client.invalidateQueries({ queryKey: ['context-usage', storyId] })
        if (['message.added', 'turn.committed', 'messages.removed', 'message.edited'].includes(record.type)) void client.invalidateQueries({ queryKey: ['rounds', storyId] })
        if (['turn.committed', 'messages.removed', 'message.edited', 'summary.created'].includes(record.type)) void client.invalidateQueries({ queryKey: ['story-recap', storyId] })
        if (['turn.committed', 'messages.removed', 'message.edited', 'profile.changed', 'state.configured'].includes(record.type)) void client.invalidateQueries({ queryKey: ['reply-state', storyId] })
        if (record.type === 'context.built' || record.type === 'context.compacted') void client.invalidateQueries({ queryKey: ['context', record.data.runId] })
        if (record.type === 'maintenance.status' && record.data.kind === 'summary') void client.invalidateQueries({ queryKey: ['summary-record', storyId, record.data.id] })
        if (record.type === 'tool.started' || record.type === 'tool.finished' || record.type === 'tool.updated') void client.invalidateQueries({ queryKey: ['run-tools'] })
        if (record.type === 'model.message' || record.type === 'tool.finished' || record.type === 'run.status') void client.invalidateQueries({ queryKey: ['run-trace', record.data.runId].filter(Boolean) })
        if (!['model.message', 'maintenance.model', 'run.draft', 'tool.updated', 'context.built', 'context.compacted'].includes(record.type)) schedule()
      })
      stream.onerror = () => {
        if (closed) return
        stream?.close(); setConnection('reconnecting')
        reconnect = setTimeout(async () => {
          if (closed) return
          try {
            await client.invalidateQueries({ queryKey: ['auth'] })
            const latest = await client.fetchQuery({ queryKey: ['story', storyId], queryFn: ({ signal }) => fetchSnapshot(signal), staleTime: 0 })
            cursor = latest.story.revision
          } catch (error) {
            if (error instanceof ApiError && error.code === 'STORY_NOT_FOUND') { stop(); notifyStoryDeleted(storyId); return }
            // Transient connection failures retain the existing transcript.
          }
          open()
        }, 2000)
      }
    }
    setConnection('connecting'); open()
    return () => { stop(); window.removeEventListener('rp-story-deleted', deleted) }
  }, [storyId, ready, client, feed])
  return { ...query, connection }
}

export async function refreshStory(id: string) {
  await Promise.all([queryClient.invalidateQueries({ queryKey: ['story-trajectory', id] }), queryClient.invalidateQueries({ queryKey: ['story', id] }), queryClient.invalidateQueries({ queryKey: ['stories'] }), queryClient.invalidateQueries({ queryKey: ['reply-state', id] })])
}
