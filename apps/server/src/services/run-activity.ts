import type { RunActivitySnapshot } from '../../../../packages/protocol/src/activity.ts'
import type { RunTrace } from '../../../../packages/protocol/src/trace.ts'
import type { StoryRepository } from '../storage/story-repository.ts'
import { modelProgress } from '../runtime/live-progress.ts'

const excerpt = (value: string) => value.replace(/\s+/g, ' ').trim().slice(-240)
/** Bounded reading surface: no prompts, raw tool results, reasoning, or preset history. */
export function runActivitySnapshot(stories: StoryRepository, trace: RunTrace): RunActivitySnapshot {
  const { run, requests, tools } = trace
  if (!['queued', 'running', 'waiting_user'].includes(run.status)) return { runId: run.id, requests: [], tools: [], live: [] }
  const visibleTools = tools.filter(tool => tool.status === 'running')
  return { runId: run.id, requests, live: modelProgress(stories, run.id),
    tools: visibleTools.map(({ callId, parentCallId, name, status, arguments: args }) => ({ callId, parentCallId, name, status,
      preview: excerpt(['file_path', 'path', 'query', 'task', 'description', 'subagent'].map(key => args[key]).find(value => typeof value === 'string') as string ?? ''),
    })),
  }
}
