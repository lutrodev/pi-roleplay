import { uiT } from "../../../lib/i18n.ts"
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { canIdlePromptSlot, movePromptSlot, movePromptSource, type PromptBuild, type PromptSource } from '../../../../../../packages/rp-core/src/context/preview.ts'

export type DragItem = { kind: 'slot' | 'source'; id: string }
export type DropTarget = { area: 'active' | 'idle'; beforeId: string | null; slotId?: string; allowed: boolean }
interface DragState { item: DragItem; label: string; x: number; y: number; offsetX: number; offsetY: number; width: number; target: DropTarget | null }
interface Options { root: RefObject<HTMLDivElement | null>; build: PromptBuild; catalog: PromptSource[]; change: (value: PromptBuild) => void; disabled: boolean }

export function promptScrollSpeed(coordinate: number, start: number, size: number) {
  const edge = Math.min(64, size / 3)
  if (coordinate < start + edge) return -Math.ceil(20 * Math.max(0, 1 - (coordinate - start) / edge))
  if (coordinate > start + size - edge) return Math.ceil(20 * Math.max(0, 1 - (start + size - coordinate) / edge))
  return 0
}

function locateTarget(root: HTMLElement, x: number, y: number, item: DragItem, options: Options): DropTarget | null {
  const hit = document.elementFromPoint(x, y)
  if (!hit || !root.contains(hit)) return null
  if (item.kind === 'slot') {
    const area = hit.closest<HTMLElement>('[data-prompt-area]')
    if (!area) return null
    const idle = area.dataset.promptArea === 'idle', slot = options.build.slots.find(slot => slot.id === item.id)
    const rows = [...area.querySelectorAll<HTMLElement>('[data-prompt-slot]')].filter(row => row.dataset.promptSlot !== item.id)
    const before = rows.find(row => { const rect = row.getBoundingClientRect(); return y < rect.top + rect.height / 2 })
    return { area: idle ? 'idle' : 'active', beforeId: before?.dataset.promptSlot ?? null,
      allowed: !!slot && !slot.locked && (!idle || canIdlePromptSlot(slot, options.catalog)) }
  }
  const row = hit.closest<HTMLElement>('[data-prompt-slot]')
  if (!row) return null
  const slot = options.build.slots.find(slot => slot.id === row.dataset.promptSlot)
  if (!slot) return null
  const sources = [...row.querySelectorAll<HTMLElement>('[data-prompt-source]')].filter(source => source.dataset.promptSource !== item.id)
  const before = sources.find(source => { const rect = source.getBoundingClientRect(); return y < rect.top + rect.height / 2 })
  return { area: 'active', slotId: slot.id, beforeId: before?.dataset.promptSource ?? null, allowed: !slot.idle && !slot.locked }
}

/** One pointer path for mouse, pen and touch; keyboard actions remain available on each handle/menu. */
export function usePromptDrag(options: Options) {
  const current = useRef(options); current.current = options
  const [drag, setDrag] = useState<DragState | null>(null), [announcement, announce] = useState('')
  const stop = useRef<() => void>(() => {}), suppressedClick = useRef<{ button: HTMLElement; until: number } | null>(null)
  useEffect(() => () => stop.current(), [])
  useEffect(() => { if (options.disabled) stop.current() }, [options.disabled])

  function start(event: ReactPointerEvent<HTMLElement>, item: DragItem, label: string) {
    if (event.button !== 0 || !event.isPrimary || current.current.disabled) return
    stop.current()
    const button = event.currentTarget, pointerId = event.pointerId
    const rect = (button.closest('[data-prompt-source]') ?? button.closest('[data-prompt-slot]') ?? button).getBoundingClientRect()
    const begin = { x: event.clientX, y: event.clientY }, point = { ...begin }
    let active = false, frame = 0, target: DropTarget | null = null
    button.setPointerCapture(pointerId)
    function update() {
      if (!active) return
      const root = current.current.root.current
      if (!root) return
      const hit = document.elementFromPoint(point.x, point.y)
      const scroll = hit?.closest<HTMLElement>('[data-prompt-scroll]')
      if (scroll && root.contains(scroll)) {
        const bounds = scroll.getBoundingClientRect()
        scroll.scrollTop += promptScrollSpeed(point.y, bounds.top, bounds.height)
      }
      target = locateTarget(root, point.x, point.y, item, current.current)
      setDrag({ item, label, x: point.x, y: point.y, offsetX: begin.x - rect.left, offsetY: begin.y - rect.top, width: rect.width, target })
      frame = requestAnimationFrame(update)
    }
    function move(next: PointerEvent) {
      if (next.pointerId !== pointerId) return
      point.x = next.clientX; point.y = next.clientY
      if (!active && Math.hypot(point.x - begin.x, point.y - begin.y) >= 5) {
        active = true; announce(uiT("正在拖动%{v0}，按 Escape 取消。", { v0: label })); update()
      }
      if (active) next.preventDefault()
    }
    function cleanup() {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', cancel)
      if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId)
      setDrag(null)
      stop.current = () => {}
    }
    function cancel() { if (active) { suppressedClick.current = { button, until: Date.now() + 150 }; announce(uiT("已取消拖动。")) }; cleanup() }
    function escape(next: KeyboardEvent) { if (next.key === 'Escape') { next.preventDefault(); next.stopImmediatePropagation(); cancel() } }
    function finish(next: PointerEvent) {
      if (next.pointerId !== pointerId) return
      if (active) {
        suppressedClick.current = { button, until: Date.now() + 150 }
        const root = current.current.root.current
        target = root ? locateTarget(root, next.clientX, next.clientY, item, current.current) : null
        if (target?.allowed) {
          const { build, catalog, change } = current.current
          const value = item.kind === 'slot' ? movePromptSlot(build, item.id, target.area === 'idle', target.beforeId, catalog)
            : movePromptSource(build, item.id, target.slotId!, target.beforeId, catalog)
          change(value); announce(uiT("已移动%{v0}，预览已更新。", { v0: label }))
        } else announce(target ? uiT("这个分组必须始终使用，不能闲置。") : uiT("未放入有效位置，顺序保持不变。"))
      }
      cleanup()
    }
    stop.current = cancel
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', cancel)
  }
  return { drag, start, announcement, consumeClick: (target?: EventTarget | null) => {
    const suppressed = suppressedClick.current
    if (!suppressed || Date.now() >= suppressed.until || !(target instanceof Node) || !suppressed.button.contains(target)) return false
    suppressedClick.current = null
    return true
  } }
}
