import { Readable } from 'node:stream'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { projectConversationRounds, type ConversationRound } from '../../../../packages/rp-core/src/story/conversation-rounds.ts'
import { projectRunTools } from '../../../../packages/rp-core/src/story/tool-records.ts'
import type { StoryEvent } from '../../../../packages/rp-core/src/types.ts'
import type { LogSummary, ModelRequestSummary, ModelUsage, RunTrace, StoryTrajectory } from '../../../../packages/protocol/src/trace.ts'
import { runActivitySnapshot } from './run-activity.ts'
import type { StoryRepository } from '../storage/story-repository.ts'
import { projectTrajectory } from './trajectory-projection.ts'

export class TraceService {
  constructor(readonly stories: StoryRepository) {}
  conversation(storyId: string, options: { before?: number; after?: number; around?: string; limit?: number; q?: string; deleted?: boolean } = {}): StoryTrajectory {
    this.stories.assertExists(storyId)
    const { before, after, around, limit = 12, q = '', deleted = false } = options
    requireValue([before, after, around].filter(value => value !== undefined).length <= 1, 'INVALID_CURSOR', '执行记录位置不正确。')
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 30, 'INVALID_LIMIT', '执行记录批量大小不正确。')
    for (const cursor of [before, after]) requireValue(cursor === undefined || Number.isSafeInteger(cursor) && cursor >= 1, 'INVALID_CURSOR', '执行记录位置不正确。')
    const runs = this.stories.database.sqlite.prepare('SELECT id FROM runs WHERE story_id = ?').all(storyId) as { id: string }[]
    const projection = projectConversationRounds(this.stories.eventsOfTypes(storyId, ['message.added', 'turn.committed', 'message.edited', 'messages.removed', 'run.status']), new Set(runs.map(run => run.id)))
    const anchor = around === undefined ? undefined : projection.rounds.find(round => round.attempts.some(attempt => attempt.runId === around))
    requireValue(around === undefined || anchor, 'INVALID_CURSOR', '执行记录位置不属于这段故事。')
    const rounds = projection.rounds.filter(round => deleted || round.state !== 'deleted')
    // Removed anchors resolve to the nearest surviving position, including an empty conversation.
    const target = anchor ? rounds.findIndex(round => round.cursor >= anchor.cursor) : -1
    const start = after !== undefined ? rounds.findIndex(round => round.cursor > after) : around !== undefined ? Math.max(0, Math.min(rounds.length - limit, (target < 0 ? rounds.length : target) - Math.floor(limit / 2))) : -1
    const endBefore = before === undefined ? rounds.length : rounds.findIndex(round => round.cursor >= before)
    const end = endBefore < 0 ? rounds.length : endBefore
    const from = after !== undefined ? start < 0 ? rounds.length : start : around !== undefined ? start : Math.max(0, end - limit)
    const through = Math.min(end, from + limit), page = rounds.slice(from, through)
    return { rounds: page.map(round => ({ id: round.id, cursor: round.cursor, round: round.round, state: round.state,
      attempts: round.attempts.map((attempt, index) => ({ ...attempt, attempt: index + 1,
        disposition: attempt.removedAt || round.state === 'deleted' ? 'deleted' : index < round.attempts.length - 1 ? 'superseded' : 'current' })),
      trajectory: this.effectiveTrajectory(round, q) })), revision: projection.revision,
      totalRounds: projection.rounds.filter(round => round.state !== 'deleted').length,
      deletedRounds: projection.rounds.filter(round => round.state === 'deleted').length, totalItems: rounds.length,
      beforeCursor: from > 0 && page.length ? page[0]!.cursor : null, afterCursor: through < rounds.length && page.length ? page.at(-1)!.cursor : null }
  }
  private effectiveTrajectory(round: ConversationRound, query: string) {
    const trajectory = this.trajectory(round.attempts.at(-1)!.runId, query)
    if (round.state === 'deleted') return trajectory // Explicitly requested deleted history.
    const inputs = new Map(round.inputs.map(input => [input.seq, input])), needle = query.toLocaleLowerCase()
    const matched = new Set(trajectory.matches)
    trajectory.entries = trajectory.entries.filter(entry => {
      if (entry.agentId !== 'main' || entry.kind !== 'user') return round.state !== 'input-only'
      const input = inputs.get(entry.seq)
      if (!input) return false
      const source = input.message.text.replace(/\s+/g, ' '), index = needle ? source.toLocaleLowerCase().indexOf(needle) : 0, start = Math.max(0, index - 50)
      entry.preview = (start ? '…' : '') + source.slice(start, start + 240) || (input.message.attachmentIds.length ? '图片与附件' : '')
      if (input.editedAt) { entry.detail = { type: 'event', seq: input.editedAt }; entry.title = '用户输入（已编辑）' }
      if (!needle || index >= 0 || entry.title.toLocaleLowerCase().includes(needle)) matched.add(entry.id)
      else matched.delete(entry.id)
      return true
    })
    if (round.state === 'input-only') { trajectory.agents = []; trajectory.requests = []; trajectory.run = { ...trajectory.run, draft: '' } }
    trajectory.matches = trajectory.entries.filter(entry => matched.has(entry.id)).map(entry => entry.id)
    trajectory.inputPreview = trajectory.entries.find(entry => entry.agentId === 'main' && entry.kind === 'user')?.preview ?? ''
    return trajectory
  }
  activity(runId: string) { return runActivitySnapshot(this.stories, this.run(runId)) }
  trajectory(runId: string, query = '') {
    const trace = this.run(runId), database = this.stories.database.sqlite
    const rows = database.prepare(`SELECT seq, type, story_id AS storyId, created_at AS createdAt, data FROM events
      WHERE story_id = ? AND (json_extract(data, '$.runId') = ? OR json_extract(data, '$.message.runId') = ?)
      AND type IN ('message.added', 'model.message', 'tool.started', 'turn.committed', 'context.built', 'context.compacted') ORDER BY seq`).iterate(trace.run.storyId, runId, runId) as Iterable<{ data: string }>
    function* events() { for (const row of rows) yield { ...row, data: JSON.parse(row.data) } as StoryEvent }
    return projectTrajectory(trace, events(), query)
  }
  tool(runId: string, callId: string) {
    const tool = this.run(runId).tools.find(tool => tool.callId === callId)
    requireValue(tool, 'TOOL_NOT_FOUND', '这次工具调用不存在。', 404)
    return { tool }
  }
  run(runId: string, query = ''): RunTrace {
    const run = this.stories.run(runId), database = this.stories.database.sqlite
    const rows = database.prepare(`SELECT seq, created_at AS createdAt, json_extract(data, '$.role') AS kind,
      json_extract(data, '$.message.requestId') AS id, json_extract(data, '$.message.scope') AS scope,
      json_extract(data, '$.message.parentCallId') AS parentCallId, json_extract(data, '$.message.provider') AS provider,
      json_extract(data, '$.message.model') AS model, json_extract(data, '$.message.elapsedMs') AS elapsedMs,
      json_extract(data, '$.message.firstTokenMs') AS firstTokenMs, json_extract(data, '$.message.response.stopReason') AS stopReason,
      json_extract(data, '$.message.response.usage') AS usage
      FROM events WHERE story_id = ? AND type = 'model.message' AND json_extract(data, '$.runId') = ?
      AND json_extract(data, '$.role') IN ('provider:request', 'provider:response') ORDER BY seq`).all(run.storyId, run.id) as {
        seq: number; createdAt: string; kind: string; id: string; scope: string; parentCallId: string | null; provider: string | null; model: string | null;
        elapsedMs: number | null; firstTokenMs: number | null; stopReason: string | null; usage: string | null
      }[]
    const requests = new Map<string, ModelRequestSummary>()
    for (const row of rows) {
      if (row.kind === 'provider:request') requests.set(row.id, { id: row.id, scope: row.scope, ...(row.parentCallId ? { parentCallId: row.parentCallId } : {}), provider: row.provider!, model: row.model!, startedAt: row.createdAt,
        status: ['queued', 'running', 'waiting_user'].includes(run.status) ? 'running' : run.status === 'cancelled' ? 'cancelled' : 'interrupted' })
      else {
        const request = requests.get(row.id)
        if (request) Object.assign(request, { status: row.stopReason === 'error' ? 'failed' : row.stopReason === 'aborted' ? 'cancelled' : row.stopReason === 'length' ? 'truncated' : 'completed',
          ...(row.elapsedMs === null ? {} : { elapsedMs: row.elapsedMs }), ...(row.firstTokenMs === null ? {} : { firstTokenMs: row.firstTokenMs }), ...(row.usage ? { usage: JSON.parse(row.usage) as ModelUsage } : {}) })
      }
    }
    const events = this.stories.toolEvents(run.storyId, run.id)
    const times = new Map<string, { startedAt?: string; finishedAt?: string }>()
    for (const event of events) if (event.type === 'tool.started' || event.type === 'tool.finished') times.set(event.data.callId, { ...times.get(event.data.callId), [event.type === 'tool.started' ? 'startedAt' : 'finishedAt']: event.createdAt })
    const tools = projectRunTools(events, run.id).map(tool => {
      const time = times.get(tool.callId) ?? {}
      return { ...tool, ...time, ...(time.startedAt && time.finishedAt ? { elapsedMs: Math.max(0, Date.parse(time.finishedAt) - Date.parse(time.startedAt)) } : {}) }
    })
    const matches = query ? (database.prepare(`SELECT DISTINCT json_extract(data,'$.message.requestId') AS id FROM events
      WHERE story_id = ? AND type = 'model.message' AND json_extract(data,'$.runId') = ? AND json_extract(data,'$.role') IN ('provider:request','provider:response')
      AND lower(data) LIKE ? ESCAPE '\\'`).all(run.storyId, run.id, '%' + query.toLocaleLowerCase().replace(/[\\%_]/g, '\\$&') + '%') as { id: string }[]).map(row => row.id) : [...requests.keys()]
    return { run, requests: [...requests.values()], tools, matches }
  }
  request(runId: string, requestId: string) {
    const run = this.stories.run(runId)
    const records = this.stories.database.sqlite.prepare(`SELECT seq, type, story_id AS storyId, created_at AS createdAt, data FROM events
      WHERE story_id = ? AND type = 'model.message' AND json_extract(data, '$.runId') = ? AND json_extract(data, '$.message.requestId') = ?
      AND json_extract(data, '$.role') IN ('provider:request','provider:response') ORDER BY seq`).all(run.storyId, run.id, requestId) as { data: string }[]
    requireValue(records.length, 'MODEL_REQUEST_NOT_FOUND', '这条模型请求不存在。', 404)
    return { records: records.map(row => ({ ...row, data: JSON.parse(row.data) })) }
  }
  logs(storyId: string, after: number, limit: number, query: string) {
    this.stories.latestSequence(storyId)
    const needle = '%' + query.toLocaleLowerCase().replace(/[\\%_]/g, '\\$&') + '%'
    const rows = this.stories.database.sqlite.prepare(`SELECT seq,type,created_at AS createdAt,length(data) AS characters,json_extract(data,'$.runId') AS runId
      FROM events WHERE story_id = ? AND seq > ? AND (? = '' OR lower(type || ' ' || data) LIKE ? ESCAPE '\\') ORDER BY seq LIMIT ?`).all(storyId, after, query, needle, limit + 1) as LogSummary[]
    const records = rows.slice(0, limit)
    return { records, nextCursor: rows.length > limit ? records.at(-1)!.seq : null }
  }
  event(storyId: string, seq: number) {
    const row = this.stories.database.sqlite.prepare('SELECT seq,story_id AS storyId,type,data,created_at AS createdAt FROM events WHERE story_id = ? AND seq = ?').get(storyId, seq) as { data: string } | undefined
    requireValue(row, 'LOG_NOT_FOUND', '这条日志不存在。', 404)
    return { ...row, data: JSON.parse(row.data) } as StoryEvent
  }
  export(storyId: string) {
    const story = this.stories.snapshot(storyId), maximum = story.revision, database = this.stories.database.sqlite
    async function* records() {
      yield JSON.stringify({ format: 'pi-roleplay-event-log', version: 1, storyId, title: story.title, throughSequence: maximum, exportedAt: new Date().toISOString() }) + '\n'
      let after = 0
      while (after < maximum) {
        const batch = database.prepare('SELECT seq,story_id AS storyId,type,data,created_at AS createdAt FROM events WHERE story_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT 20').all(storyId, after, maximum) as { seq: number; data: string }[]
        if (!batch.length) break
        for (const row of batch) yield JSON.stringify({ ...row, data: JSON.parse(row.data) }) + '\n'
        after = batch.at(-1)!.seq
      }
    }
    return { stream: Readable.from(records()), name: `${story.title || '会话'}-日志.jsonl` }
  }
}
