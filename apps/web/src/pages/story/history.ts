import { uiT } from "../../lib/i18n.ts"
import { useEffect, useState } from 'react'
import type { StoryMessage } from '../../../../../packages/rp-core/src/types.ts'
import type { MessagePage } from '../../../../../packages/protocol/src/reading.ts'
import { api, type StoryData, useAction } from '../../lib/api.ts'

const pages = new Map<string, { older: StoryMessage[]; cursor?: string | null }>()
export function clearReadingHistory(storyId: string) { pages.delete(storyId) }

export function useReadingHistory(storyId: string, data?: StoryData) {
  const [older, setOlder] = useState<StoryMessage[]>(() => pages.get(storyId)?.older ?? []), [cursor, setCursor] = useState<string | null | undefined>(() => pages.get(storyId)?.cursor), action = useAction()
  useEffect(() => {
    pages.set(storyId, { older, cursor })
    if (pages.size > 20) pages.delete(pages.keys().next().value!)
  }, [storyId, older, cursor])
  useEffect(() => {
    const reset = (event: Event) => { if ((event as CustomEvent).detail === storyId) { pages.delete(storyId); setOlder([]); setCursor(undefined) } }
    window.addEventListener('rp-history-changed', reset)
    const feedback = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.storyId === storyId) setOlder(current => current.map(message => message.id === detail.messageId ? { ...message, feedback: { rating: detail.rating, comment: detail.comment } } : message)) }
    window.addEventListener('rp-message-feedback', feedback)
    return () => { window.removeEventListener('rp-history-changed', reset); window.removeEventListener('rp-message-feedback', feedback) }
  }, [storyId])
  // Retain the already visible window even before the first manual history load.
  // A newer server window must not remove its head while the user is reading it.
  useEffect(() => {
    if (!data) return
    setOlder(current => merge(current, data.story.messages))
    setCursor(current => current === undefined ? data.history.before : current)
  }, [data?.story.messages, data?.history.before])
  const before = cursor === undefined ? data?.history.before : cursor
  return { messages: merge(older, data?.story.messages ?? []), before, ...action,
    reveal: (messageId: string) => action.run(async () => {
      let visible = merge(older, data?.story.messages ?? []), next = before
      while (!visible.some(message => message.id === messageId)) {
        if (!next) throw new Error(uiT("目标消息已不存在，请刷新会话后重试。"))
        const page = await api<MessagePage>(`/stories/${storyId}/messages?before=${encodeURIComponent(next)}`)
        if (page.before === next) throw new Error(uiT("历史分页未前进，请刷新会话后重试。"))
        visible = merge(page.messages, visible); next = page.before
        setOlder(visible); setCursor(next)
      }
    }),
    load: () => action.run(async () => {
      if (!before) return
      const page = await api<MessagePage>(`/stories/${storyId}/messages?before=${encodeURIComponent(before)}`)
      setOlder(current => merge(page.messages, merge(current, data?.story.messages ?? [])))
      setCursor(page.before)
    }),
  }
}
function merge(before: StoryMessage[], after: StoryMessage[]) {
  const replacements = new Map(after.map(message => [message.id, message]))
  const ids = new Set(before.map(message => message.id))
  return [...before.map(message => replacements.get(message.id) ?? message), ...after.filter(message => !ids.has(message.id))]
}
