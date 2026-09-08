import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { queryClient, type StoryData } from '../lib/api.ts'
import { clearStoryDraft } from '../pages/story/draft.ts'
import { clearReadingHistory } from '../pages/story/history.ts'
import { clearReadingPosition } from '../pages/story/reader-scroll.ts'

/** Keep deletion local to its conversation, including notifications from another tab's SSE. */
export function useStoryDeletionHandler() {
  const router = useRouter()
  useEffect(() => {
    const pending = new Set<string>()
    const deleted = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      if (pending.has(id)) return
      pending.add(id)
      void (async () => {
        const data = queryClient.getQueryData<StoryData>(['story', id]), runIds = new Set(data?.runs.map(run => run.id))
        const matches = (query: { queryKey: readonly unknown[] }) => query.queryKey[1] === id || runIds.has(String(query.queryKey[1]))
        await queryClient.cancelQueries({ predicate: matches })
        if (router.state.location.pathname === `/stories/${id}`) await router.navigate({ to: '/', replace: true })
        // Unmount first so draft/scroll cleanup cannot write back deleted local data.
        clearStoryDraft(id); clearReadingHistory(id); clearReadingPosition(id)
        queryClient.removeQueries({ predicate: matches })
        await Promise.all(['stories', 'sidebar-order', 'workspaces', 'story'].map(key => queryClient.invalidateQueries({ queryKey: [key] })))
        requestAnimationFrame(() => {
          if (!document.querySelector('[role="dialog"][data-state="open"]') && document.activeElement === document.body) document.querySelector<HTMLElement>('.sidebar-slot:not([inert]) .sidebar-all, #main-content')?.focus({ preventScroll: true })
        })
      })().finally(() => pending.delete(id))
    }
    window.addEventListener('rp-story-deleted', deleted)
    return () => window.removeEventListener('rp-story-deleted', deleted)
  }, [router])
}
