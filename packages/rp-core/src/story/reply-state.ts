import { requireValue } from '../errors.ts'
import { projectStory } from './projection.ts'
import type { StateUpdate, StoryEvent, StoryState } from '../types.ts'

/** Reconstruct the surviving turn's state boundary, including configuration owned by tool messages. */
export function replyState(events: readonly StoryEvent[], messageId: string) {
  const story = projectStory(events), target = story.messages.find(message => message.id === messageId)
  requireValue(target?.role === 'assistant' && (target.kind === 'narrative' || target.kind === 'message'), 'MESSAGE_NOT_FOUND', '这条回复已不存在，请刷新故事。', 404)
  const first = events[0]
  requireValue(first?.type === 'story.created', 'STORY_CORRUPT', '故事缺少创建记录。', 500)
  let bootstrap = first.data.bootstrap
  for (const event of events) if (event.type === 'profile.changed' && event.data.bootstrap) bootstrap = event.data.bootstrap
  const state = structuredClone(bootstrap), active = new Set(story.messages.map(message => message.id))
  let before: StoryState | undefined
  const apply = (updates: StateUpdate[]) => {
    for (const update of updates) {
      if (update.snapshot === null) delete state.namespaces[update.namespace]
      else state.namespaces[update.namespace] = structuredClone(update.snapshot)
    }
  }
  for (const event of events) {
    if ((event.type === 'message.added' || event.type === 'turn.committed') && active.has(event.data.message.id)) {
      if (!before && event.data.message.turnId === target.turnId) before = structuredClone(state)
      if (event.type === 'turn.committed') apply(event.data.stateUpdates)
      // The same assistant owner is first journaled as a tool message, then promoted by commit.
      if (event.data.message.id === messageId && event.data.message.kind !== 'tool') return { before: before ?? structuredClone(state), after: state }
    } else if (event.type === 'state.configured' && active.has(event.data.ownerMessageId)) apply([event.data.update])
  }
  throw new Error('A visible narrative has no source event')
}
