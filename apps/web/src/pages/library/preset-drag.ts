import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { uiT } from '../../lib/i18n.ts'

interface DragState { id: string; label: string; x: number; y: number; before: string | null; valid: boolean }
interface Options { root: RefObject<HTMLElement | null>; ids: string[]; disabled: boolean; reorder: (ids: string[]) => void }

/** Drag only from the handle; keep every text field usable and commit the order on drop. */
export function usePresetDrag(options: Options) {
  const current = useRef(options); current.current = options
  const [drag, setDrag] = useState<DragState | null>(null), [announcement, announce] = useState('')
  const stop = useRef<() => void>(() => {})
  useEffect(() => () => stop.current(), [])
  useEffect(() => { if (options.disabled) stop.current() }, [options.disabled])

  function start(event: ReactPointerEvent<HTMLButtonElement>, id: string, label: string) {
    if (event.button !== 0 || !event.isPrimary || current.current.disabled) return
    stop.current()
    const button = event.currentTarget, pointerId = event.pointerId, origin = { x: event.clientX, y: event.clientY }, point = { ...origin }
    const scroll = button.closest<HTMLElement>('.modal-body')
    let active = false, frame = 0
    button.setPointerCapture(pointerId)
    const target = () => {
      const root = current.current.root.current
      if (!root) return { valid: false, before: null }
      const bounds = root.getBoundingClientRect()
      const valid = point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom
      const before = [...root.querySelectorAll<HTMLElement>('[data-preset-field]')].filter(card => card.dataset.presetField !== id)
        .find(card => { const box = card.getBoundingClientRect(); return point.y < box.top + box.height / 2 })?.dataset.presetField ?? null
      return { valid, before }
    }
    function tick() {
      if (scroll) {
        const bounds = scroll.getBoundingClientRect(), edge = Math.min(56, bounds.height / 3)
        const speed = point.y < bounds.top + edge ? -Math.min(18, Math.ceil((bounds.top + edge - point.y) / 3))
          : point.y > bounds.bottom - edge ? Math.min(18, Math.ceil((point.y - bounds.bottom + edge) / 3)) : 0
        scroll.scrollTop += speed
      }
      setDrag({ id, label, ...point, ...target() }); frame = requestAnimationFrame(tick)
    }
    function move(next: PointerEvent) {
      if (next.pointerId !== pointerId) return
      point.x = next.clientX; point.y = next.clientY
      if (!active && Math.hypot(point.x - origin.x, point.y - origin.y) >= 5) {
        active = true; announce(uiT('正在拖动%{v0}，按 Escape 取消。', { v0: label })); tick()
      }
      if (active) next.preventDefault()
    }
    function cleanup() {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape, true)
      if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId)
      setDrag(null); stop.current = () => {}
    }
    function cancel() { if (active) announce(uiT('已取消拖动。')); cleanup() }
    function escape(next: KeyboardEvent) { if (next.key === 'Escape') { next.preventDefault(); next.stopImmediatePropagation(); cancel() } }
    function finish(next: PointerEvent) {
      if (next.pointerId !== pointerId) return
      point.x = next.clientX; point.y = next.clientY
      const drop = target()
      if (active && drop.valid) {
        const ids = current.current.ids.filter(value => value !== id), at = drop.before ? ids.indexOf(drop.before) : ids.length
        ids.splice(at < 0 ? ids.length : at, 0, id); current.current.reorder(ids)
        announce(uiT('已移动%{v0}。', { v0: label }))
        requestAnimationFrame(() => { button.focus({ preventScroll: true }); button.scrollIntoView({ block: 'nearest' }) })
      } else if (active) announce(uiT('未放入有效位置，顺序保持不变。'))
      cleanup()
    }
    stop.current = cancel
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel); window.addEventListener('keydown', escape, true)
  }
  return { drag, start, announcement }
}
