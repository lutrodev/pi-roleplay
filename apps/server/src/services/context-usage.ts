import type { ContextUsage } from '../../../../packages/protocol/src/context-usage.ts'
import type { StoryRepository } from '../storage/story-repository.ts'

export function contextUsage(stories: StoryRepository, storyId: string): ContextUsage[] {
  stories.assertExists(storyId)
  const db = stories.database.sqlite
  return (['main', 'writer'] as const).flatMap(scope => {
    const request = db.prepare(`SELECT json_extract(data, '$.runId') AS runId,
      json_extract(data, '$.message.requestId') AS requestId, json_extract(data, '$.message.model') AS model,
      json_extract(data, '$.message.contextWindow') AS contextWindow, created_at AS at
      FROM events WHERE story_id = ? AND type = 'model.message' AND json_extract(data, '$.role') = 'provider:request'
      AND (json_extract(data, '$.message.scope') = ? OR (? = 'writer' AND substr(json_extract(data, '$.message.scope'), 1, 7) = 'writer:')) ORDER BY seq DESC LIMIT 1`).get(storyId, scope, scope) as Omit<ContextUsage, 'scope' | 'used' | 'input' | 'output'> | undefined
    if (!request) return []
    const result = db.prepare(`SELECT json_extract(data, '$.message.response.usage') AS usage,
      json_extract(data, '$.message.response.stopReason') AS reason FROM events WHERE story_id = ? AND type = 'model.message'
      AND json_extract(data, '$.role') = 'provider:response' AND json_extract(data, '$.message.requestId') = ? ORDER BY seq DESC LIMIT 1`).get(storyId, request.requestId) as { usage: string | null; reason: string } | undefined
    const usage = result?.usage && !['error', 'aborted'].includes(result.reason) ? JSON.parse(result.usage) as Record<string, unknown> : undefined
    const valid = usage && ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && Number(usage[key]) >= 0)
    const input = valid ? Number(usage.input) + Number(usage.cacheRead) + Number(usage.cacheWrite) : null
    const output = valid ? Number(usage.output) : null
    return [{ ...request, scope, input, output, used: input !== null && output !== null && input + output > 0 ? input + output : null }]
  })
}
