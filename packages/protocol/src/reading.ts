import type { StoryEvent, StoryMessage, StorySnapshot, ToolRecord } from '../../rp-core/src/types.ts'
import { requireValue } from '../../rp-core/src/errors.ts'

export interface MessagePage { messages: StoryMessage[]; before: string | null; total: number; revision: number }
export type ActiveTool = Pick<ToolRecord, 'runId' | 'name'>
export interface RecapPage { items: StorySnapshot['summaries']; before: string | null; total: number; revision: number }
/** Plot recaps are read on demand; they do not inflate the live conversation snapshot. */
export function recapPage(story: StorySnapshot, before?: string, limit = 5): RecapPage {
  const covered = new Set(story.checkpoint?.sourceMessageIds)
  const recaps = story.summaries.filter(item => item.text.trim() && !covered.has(item.messageId))
  const end = before ? recaps.findIndex(item => item.messageId === before) : recaps.length
  requireValue(end >= 0, 'HISTORY_CHANGED', '剧情回顾已更新，请刷新后继续阅读。', 409)
  const start = Math.max(0, end - Math.min(20, Math.max(1, limit)))
  return { items: recaps.slice(start, end).reverse(), before: start > 0 ? recaps[start]!.messageId : null, total: recaps.length, revision: story.revision }
}
export function messagePage(story: StorySnapshot, before?: string, limit = 30): MessagePage {
  const messages = story.messages.filter(message => message.kind !== 'tool')
  const end = before ? messages.findIndex(message => message.id === before) : messages.length
  requireValue(end >= 0, 'HISTORY_CHANGED', '较早消息已变更，请刷新故事后继续阅读。', 409)
  const start = Math.max(0, end - Math.min(50, Math.max(1, limit)))
  return { messages: messages.slice(start, end), before: start > 0 ? messages[start]!.id : null, total: messages.length, revision: story.revision }
}
export function readingView(story: StorySnapshot) {
  const page = messagePage(story)
  const latestReplyId = story.messages.findLast(message => message.role === 'assistant' && (message.kind === 'narrative' || message.kind === 'message'))?.id ?? null
  const activeTools: ActiveTool[] = story.tools.filter(tool => tool.status === 'running').map(({ runId, name }) => ({ runId, name }))
  return { story: { ...story, messages: page.messages, tools: [], summaries: [], questions: story.questions.filter(question => question.status === 'pending') }, activeTools, history: { before: page.before, total: page.total }, latestReplyId }
}

export interface StoryNotice { seq: number; storyId: string; type: StoryEvent['type']; data: Record<string, unknown> }
/** SSE carries invalidations and live prose; large audit/context/tool payloads have explicit read endpoints. */
export function storyNotice(event: StoryEvent): StoryNotice {
  const data: Record<string, unknown> = {}
  if (event.type === 'run.draft' || event.type === 'message.feedback') Object.assign(data, event.data)
  else for (const key of ['runId', 'id', 'kind', 'status', 'messageId']) {
    const value = (event.data as unknown as Record<string, unknown>)[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') data[key] = value
  }
  return { seq: event.seq, storyId: event.storyId, type: event.type, data }
}
