import { storyReferenceIds } from '../../../../packages/rp-core/src/interaction/references.ts'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { StorySnapshot } from '../../../../packages/rp-core/src/types.ts'
import type { StoryRepository } from '../storage/story-repository.ts'

export function storyReferences(repository: StoryRepository, story: StorySnapshot, runId: string) {
  const ids = storyReferenceIds(story.messages.filter(message => message.runId === runId && message.role === 'user').map(message => message.text).join('\n'))
  requireValue(ids.length <= 4, 'REFERENCE_LIMIT', '每轮最多引用 4 段会话。')
  return ids.map(id => {
    requireValue(id !== story.id, 'INVALID_REFERENCE', '当前会话已包含在上下文中，请引用其他会话。')
    const source = repository.snapshot(id)
    const original = source.messages.filter(message => !['tool', 'draft'].includes(message.kind))
    const conversation = original.map(({ role, text }) => ({ role, text }))
    let omittedMessages = 0, omittedCharacters = 0
    // Retain recent visible dialogue; never expose reasoning, hidden/deleted turns, keys or raw tool output.
    let length = conversation.reduce((sum, message) => sum + message.text.length, 0)
    while (length > 24000 && conversation.length > 1) {
      const removed = conversation.shift()!; length -= removed.text.length; omittedMessages++
    }
    if (conversation[0] && length > 24000) {
      omittedCharacters = length - 24000
      conversation[0].text = conversation[0].text.slice(0, 12000) + '\n[中间内容已截短]\n' + conversation[0].text.slice(-12000)
    }
    return { storyId: id, title: source.title, throughSequence: source.revision, conversation, omittedMessages, omittedCharacters }
  })
}
