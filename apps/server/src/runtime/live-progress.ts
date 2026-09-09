import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import type { ModelActivity } from '../../../../packages/protocol/src/activity.ts'
import type { StoryRepository } from '../storage/story-repository.ts'

// A repository identifies one application instance; concurrent fixtures and stories stay isolated.
// Only in-flight requests live here. Durable requests/responses remain in RunJournal.
const requests = new WeakMap<StoryRepository, Map<string, Map<string, ModelActivity>>>()
export function modelProgress(stories: StoryRepository, runId: string): ModelActivity[] {
  return [...(requests.get(stories)?.get(runId)?.values() ?? [])].map(value => ({ ...value }))
}
export function beginModelProgress(stories: StoryRepository, runId: string, requestId: string) {
  let runs = requests.get(stories)
  if (!runs) { runs = new Map(); requests.set(stories, runs) }
  let active = runs.get(runId)
  if (!active) { active = new Map(); runs.set(runId, active) }
  const progress: ModelActivity = { requestId, phase: 'waiting', text: '' }
  active.set(requestId, progress)
  let closed = false
  return {
    queued(value: boolean) { if (!closed) progress.phase = value ? 'queued' : 'waiting' },
    update(event: AssistantMessageEvent) {
      if (closed) return
      if (event.type === 'thinking_delta') progress.phase = 'thinking'
      if (event.type === 'text_delta') {
        progress.phase = 'responding'
        progress.text = [...(progress.text + event.delta)].slice(-320).join('')
      }
      if (event.type === 'toolcall_start' || event.type === 'toolcall_delta') {
        progress.phase = 'tool'
        const call = event.partial.content[event.contentIndex]
        if (call?.type === 'toolCall') progress.toolName = call.name
      }
    },
    close() {
      if (closed) return
      closed = true
      active.delete(requestId)
      if (!active.size) runs.delete(runId)
    },
  }
}
