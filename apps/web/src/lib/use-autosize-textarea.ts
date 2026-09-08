import { useLayoutEffect, type RefObject } from 'react'

/** Reflow on text, viewport and column-width changes, with only the text surface scrolling. */
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, minimum: number, maximum: number, viewportFraction: number, enabled = true) {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !enabled) return
    const resize = () => {
      element.style.height = '0px'
      // scrollHeight excludes borders and rounds fractional line heights. Include
      // both so a short answer does not gain a scrollbar for a fraction of a pixel.
      const measuredHeight = element.scrollHeight + element.offsetHeight - element.clientHeight
      const contentHeight = measuredHeight + (measuredHeight > minimum ? 1 : 0)
      element.style.height = `${Math.max(minimum, Math.min(contentHeight, maximum, window.innerHeight * viewportFraction))}px`
    }
    let width = element.clientWidth
    resize()
    const observer = new ResizeObserver(() => { if (width !== element.clientWidth) { width = element.clientWidth; resize() } })
    observer.observe(element)
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); window.removeEventListener('resize', resize) }
  }, [ref, value, minimum, maximum, viewportFraction, enabled])
}
