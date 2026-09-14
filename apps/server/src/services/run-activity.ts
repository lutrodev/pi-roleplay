import type { ActivityTool, AgentActivity, RunActivitySnapshot } from '../../../../packages/protocol/src/activity.ts'
import type { RunRecord } from '../../../../packages/rp-core/src/types.ts'
import type { StoryRepository } from '../storage/story-repository.ts'
import { modelProgress } from '../runtime/live-progress.ts'
import { modelRequestSummaries } from './model-requests.ts'

const excerpt = (value: string) => [...value.replace(/\s+/g, ' ').trim()].slice(-240).join('')
const activeRun = (run: RunRecord) => ['queued', 'running', 'waiting_user'].includes(run.status)

/** Read bounded descriptions and indexed lifecycle records, never replay growing tool outputs. */
function activityTools(stories: StoryRepository, run: RunRecord): ActivityTool[] {
  const rows = stories.database.sqlite.prepare(`SELECT json_extract(s.data, '$.callId') AS callId,
    json_extract(s.data, '$.parentCallId') AS parentCallId, json_extract(s.data, '$.name') AS name,
    s.created_at AS startedAt, f.created_at AS finishedAt, json_extract(f.data, '$.failed') AS failed,
    CASE WHEN json_extract(f.data, '$.failed') AND json_valid(json_extract(f.data, '$.result.content[0].text'))
      THEN json_extract(json_extract(f.data, '$.result.content[0].text'), '$.code') END AS errorCode,
    COALESCE(substr(json_extract(s.data, '$.arguments.file_path'), 1, 240), substr(json_extract(s.data, '$.arguments.path'), 1, 240),
      substr(json_extract(s.data, '$.arguments.query'), 1, 240), substr(json_extract(s.data, '$.arguments.task'), 1, 240),
      substr(json_extract(s.data, '$.arguments.brief'), 1, 240), substr(json_extract(s.data, '$.arguments.description'), 1, 240), '') AS preview,
    (SELECT u.created_at FROM events u WHERE u.story_id = s.story_id AND u.type = 'tool.updated'
      AND json_extract(u.data, '$.callId') = json_extract(s.data, '$.callId') ORDER BY u.seq DESC LIMIT 1) AS updatedAt
    FROM events s LEFT JOIN events f ON f.seq = (SELECT e.seq FROM events e WHERE e.story_id = s.story_id AND e.type = 'tool.finished'
      AND json_extract(e.data, '$.callId') = json_extract(s.data, '$.callId') ORDER BY e.seq DESC LIMIT 1)
    WHERE s.story_id = ? AND s.type = 'tool.started' AND json_extract(s.data, '$.runId') = ? ORDER BY s.seq`).all(run.storyId, run.id) as {
      callId: string; parentCallId: string | null; name: string; preview: string; startedAt: string; updatedAt: string | null; finishedAt: string | null; failed: number | null; errorCode: string | null
    }[]
  return rows.map(row => {
    const stopped = ['RUN_CANCELLED', 'PROCESS_INTERRUPTED', 'TOOL_CANCELLED', 'SEARCH_CANCELLED'].includes(row.errorCode ?? '')
    const status = !row.finishedAt ? activeRun(run) ? 'running' : 'interrupted'
      : !row.failed ? 'completed' : stopped ? 'interrupted' : 'failed'
    return { callId: row.callId, ...(row.parentCallId ? { parentCallId: row.parentCallId } : {}), name: row.name,
      preview: excerpt(row.preview), startedAt: row.startedAt, status,
      updatedAt: row.finishedAt ?? row.updatedAt ?? row.startedAt,
      ...(row.finishedAt ? { finishedAt: row.finishedAt } : !activeRun(run) ? { finishedAt: run.updatedAt } : {}) }
  })
}

/** A disposable read projection: durable call identity and terminal state + transient model activity. */
export function runActivitySnapshot(stories: StoryRepository, run: RunRecord): RunActivitySnapshot {
  const requests = modelRequestSummaries(stories, run), tools = activityTools(stories, run)
  const live = activeRun(run) ? modelProgress(stories, run.id) : []
  const metadata = stories.database.sqlite.prepare(`SELECT json_extract(data, '$.ownerMessageId') AS callId,
    substr(json_extract(data, '$.message.subagentName'), 1, 80) AS name
    FROM events WHERE story_id = ? AND type = 'model.message' AND json_extract(data, '$.runId') = ?
    AND json_extract(data, '$.role') = 'task:request' ORDER BY seq`).all(run.storyId, run.id) as { callId: string; name: string }[]
  const names = new Map(metadata.map(row => [row.callId, row.name]))
  // Only public task text is eligible for snippets. Thinking, prompts, images and raw tool results stay in the trace.
  const responses = stories.database.sqlite.prepare(`SELECT json_extract(data, '$.message.parentCallId') AS callId, created_at AS updatedAt,
    substr((SELECT group_concat(json_extract(part.value, '$.text'), '') FROM json_each(data, '$.message.response.content') part
      WHERE json_extract(part.value, '$.type') = 'text'), -320) AS text
    FROM events WHERE story_id = ? AND type = 'model.message' AND json_extract(data, '$.runId') = ?
    AND json_extract(data, '$.role') = 'provider:response' AND json_extract(data, '$.message.scope') LIKE 'task:%'
    ORDER BY seq`).all(run.storyId, run.id) as { callId: string; updatedAt: string; text: string | null }[]
  const latestText = new Map(responses.filter(row => row.text?.trim()).map(row => [row.callId, row]))
  const agents = tools.filter(tool => ['rp_write_turn', 'rp_run_subagent'].includes(tool.name)).map((tool): AgentActivity => {
    const children = requests.filter(request => request.parentCallId === tool.callId), current = children.findLast(request => request.status === 'running')
    const progress = live.find(item => item.requestId === current?.id), childTools = tools.filter(child => child.parentCallId === tool.callId)
    const working = childTools.filter(child => child.status === 'running'), response = latestText.get(tool.callId)
    const kind = tool.name === 'rp_write_turn' ? 'writer' : 'task'
    const status = tool.status === 'interrupted' && run.status === 'cancelled' ? 'cancelled' : tool.status
    const phase = working.some(child => child.name === 'ask_user_question') && run.status === 'waiting_user' ? 'waiting_user'
      : working.length ? 'tools' : progress?.phase ?? (current ? 'waiting' : 'continuing')
    const updatedAt = [tool.updatedAt, ...children.map(child => child.startedAt), ...childTools.map(child => child.updatedAt),
      ...responses.filter(row => row.callId === tool.callId).map(row => row.updatedAt), ...(progress ? [progress.updatedAt] : [])].sort().at(-1)!
    return { callId: tool.callId, parentCallId: tool.parentCallId, kind, name: kind === 'writer' ? 'Writer' : names.get(tool.callId) ?? '任务子代理',
      task: tool.preview, status, phase, startedAt: tool.startedAt, updatedAt, finishedAt: tool.finishedAt,
      model: children.at(-1)?.model, requestCount: children.length,
      text: kind === 'writer' ? '' : excerpt(progress?.text.trim() || response?.text || ''),
      tools: childTools.filter(child => child.status === 'running' || childTools.slice(-8).includes(child)), toolCount: childTools.length }
  })
  return { runId: run.id, requests: activeRun(run) ? requests : [], live, tools: tools.filter(tool => tool.status === 'running'), agents }
}
