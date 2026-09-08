import { uiT, uiLocale } from "./i18n.ts"
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from './api.ts'

export interface StoryListItem { workspaceId?: string | null; id: string; title: string; updatedAt: string; createdAt: string; archived: boolean; status?: string | null; parentStoryId?: string | null; match?: { messageId: string; snippet: string } }
export function useStories(archived = false, query = '', refetchInterval: number | false = false) {
  const [search, setSearch] = useState(query.trim())
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 180); return () => clearTimeout(timer) }, [query])
  return useQuery({ queryKey: ['stories', archived, search], refetchInterval, queryFn: ({ signal }) => api<{ stories: StoryListItem[] }>(`/stories?archived=${archived}&q=${encodeURIComponent(search)}`, 'GET', undefined, signal) })
}
export function storyDate(value: string) {
  const date = new Date(value), now = new Date(), yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === now.toDateString()) return uiT("今天")
  if (date.toDateString() === yesterday.toDateString()) return uiT("昨天")
  return date.toLocaleDateString(uiLocale(), { ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const }), month: 'numeric', day: 'numeric' })
}
