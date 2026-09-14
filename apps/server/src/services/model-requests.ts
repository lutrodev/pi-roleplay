import type { ModelRequestSummary, ModelUsage } from '../../../../packages/protocol/src/trace.ts'
import type { RunRecord } from '../../../../packages/rp-core/src/types.ts'
import type { StoryRepository } from '../storage/story-repository.ts'

/** Select metadata in SQLite without loading model prompts or response bodies. */
export function modelRequestSummaries(stories: StoryRepository, run: RunRecord): ModelRequestSummary[] {
  const rows = stories.database.sqlite.prepare(`SELECT seq, created_at AS createdAt, json_extract(data, '$.role') AS kind,
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
  return [...requests.values()]
}
