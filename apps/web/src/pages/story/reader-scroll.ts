import { useLayoutEffect, useRef, useState } from 'react'

interface ReadingPosition { top: number; follow: boolean; anchor?: string; offset?: number }
interface ScrollPosition { top: number; height: number; viewport: number }
const scrollPosition = (element: HTMLDivElement): ScrollPosition => ({ top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight })
export function followsReadingScroll(previous: ScrollPosition, next: ScrollPosition, following: boolean) {
  if (next.height - next.top - next.viewport < 64) return true
  // Layout changes can clamp scrollTop; only an upward reading gesture pauses following.
  const movedUp = next.top < previous.top - 1
  const layoutChanged = next.viewport !== previous.viewport || next.height < previous.height
  return movedUp && !layoutChanged ? false : following
}
const positions = new Map<string, ReadingPosition>()
export function clearReadingPosition(storyId: string) {
  positions.delete(storyId)
  try { sessionStorage.removeItem(`rp-reading:${storyId}`) } catch { /* Browser storage may be unavailable. */ }
}
function savedPosition(storyId: string) {
  if (positions.has(storyId)) return positions.get(storyId)
  try {
    const value = JSON.parse(sessionStorage.getItem(`rp-reading:${storyId}`) ?? 'null')
    if (value && Number.isFinite(value.top) && typeof value.follow === 'boolean' && (value.anchor === undefined || typeof value.anchor === 'string') && (value.offset === undefined || Number.isFinite(value.offset))) return value as ReadingPosition
  } catch { /* Reading is available without browser persistence. */ }
}

export function useReaderScroll(storyId: string, ready: boolean, revision?: number) {
  const scroll = useRef<HTMLDivElement>(null), follow = useRef(true), [atBottom, setAtBottom] = useState(true)
  const lastScroll = useRef<ScrollPosition>({ top: 0, height: 0, viewport: 0 })
  const jump = () => { follow.current = true; const element = scroll.current; if (element) { element.scrollTop = element.scrollHeight; lastScroll.current = scrollPosition(element) }; setAtBottom(true) }
  useLayoutEffect(() => {
    const element = scroll.current
    if (!ready || !element) return
    const saved = savedPosition(storyId)
    follow.current = saved?.follow ?? true
    if (follow.current) element.scrollTop = element.scrollHeight
    else {
      const anchor = saved?.anchor && element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(saved.anchor)}"]`)
      element.scrollTop = anchor ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - (saved?.offset ?? 0) : saved?.top ?? 0
    }
    lastScroll.current = scrollPosition(element)
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 64)
    const persist = () => {
      const top = element.getBoundingClientRect().top
      const anchor = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(message => message.getBoundingClientRect().bottom > top)
      const value: ReadingPosition = { top: element.scrollTop, follow: follow.current, anchor: anchor?.dataset.messageId, offset: anchor ? anchor.getBoundingClientRect().top - top : undefined }
      positions.set(storyId, value)
      if (positions.size > 100) positions.delete(positions.keys().next().value!)
      try { sessionStorage.setItem(`rp-reading:${storyId}`, JSON.stringify(value)) } catch { /* The in-memory position remains available. */ }
    }
    let resizeFrame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        if (follow.current) element.scrollTop = element.scrollHeight
        lastScroll.current = scrollPosition(element)
        setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 64)
      })
    })
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    window.addEventListener('pagehide', persist)
    return () => { persist(); observer.disconnect(); cancelAnimationFrame(resizeFrame); window.removeEventListener('pagehide', persist) }
  }, [ready, storyId])
  // Follow committed prose without coupling reading position to auxiliary windows.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!ready || !scroll.current) return
      if (follow.current) scroll.current.scrollTop = scroll.current.scrollHeight
      lastScroll.current = scrollPosition(scroll.current)
      setAtBottom(scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 64)
    })
    return () => cancelAnimationFrame(frame)
  }, [revision, ready])
  const onScroll = () => {
    const element = scroll.current
    if (!element) return
    const next = scrollPosition(element)
    follow.current = followsReadingScroll(lastScroll.current, next, follow.current)
    lastScroll.current = next
    setAtBottom(next.height - next.top - next.viewport < 64)
  }
  return { scroll, follow, atBottom, jump, onScroll }
}
