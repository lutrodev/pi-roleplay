import { uiT, useUiLanguage } from "../lib/i18n.ts"
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Reorder, useDragControls, useReducedMotion } from 'motion/react'
import { GripVertical } from 'lucide-react'

export interface SortableRow { id: string; label: string; detail?: string; badge?: string }
interface Props { label: string; rows: SortableRow[]; selected?: string; onSelect?: (id: string) => void; onReorder: (ids: string[]) => void; disabled?: boolean; className?: string; details?: (id: string) => ReactNode; actions?: (id: string) => ReactNode }
export function SortableRows({ label, rows, selected, onSelect, onReorder, disabled = false, className = '', details, actions }: Props) {
  useUiLanguage()
  const ids = rows.map(row => row.id)
  return <Reorder.Group axis="y" values={ids} onReorder={onReorder} layoutScroll aria-label={label} className={`sortable-rows ${className}`}>
    {rows.map(row => <Row key={row.id} row={row} ids={ids} selected={row.id === selected} onSelect={onSelect} onReorder={onReorder} disabled={disabled} details={details} actions={actions} />)}
  </Reorder.Group>
}
function Row({ row, ids, selected, onSelect, onReorder, disabled, details, actions }: Pick<Props, 'onSelect' | 'onReorder' | 'disabled' | 'details' | 'actions'> & { row: SortableRow; ids: string[]; selected: boolean }) {
  useUiLanguage()
  const controls = useDragControls(), reduced = useReducedMotion(), [dragging, setDragging] = useState(false)
  const original = useRef(ids), current = useRef(onReorder), pointer = useRef<{ y: number; scroll: HTMLElement } | null>(null)
  current.current = onReorder
  useEffect(() => {
    if (!dragging) return
    let frame = 0
    const cancel = () => { controls.cancel(); current.current(original.current); setDragging(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel() } }
    const tick = () => {
      if (pointer.current) {
        const { scroll, y } = pointer.current, bounds = scroll.getBoundingClientRect(), edge = Math.min(45, bounds.height / 3)
        const speed = y < bounds.top + edge ? -Math.ceil((bounds.top + edge - y) / 4) : y > bounds.bottom - edge ? Math.ceil((y - bounds.bottom + edge) / 4) : 0
        scroll.scrollTop += speed
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    window.addEventListener('keydown', escape, true); window.addEventListener('blur', cancel); window.addEventListener('pointercancel', cancel)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', cancel); window.removeEventListener('pointercancel', cancel) }
  }, [dragging, controls])
  return <Reorder.Item value={row.id} dragListener={false} dragControls={controls} dragMomentum={false} layout="position" className="sortable-row" data-selected={selected || undefined} data-dragging={dragging || undefined}
    transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 480, damping: 38 }}
    onDragStart={() => setDragging(true)} onDragEnd={() => { setDragging(false); pointer.current = null }}
    onDrag={(_, info) => { if (pointer.current) pointer.current.y = info.point.y }}>
    <button type="button" className="sort-handle" disabled={disabled} aria-label={uiT("拖动排序 %{v0}；上下方向键排序", { v0: row.label })} onPointerDown={event => {
      original.current = [...ids]; const list = event.currentTarget.closest<HTMLElement>('.sortable-rows')!; pointer.current = { y: event.clientY, scroll: list.scrollHeight > list.clientHeight ? list : list.closest<HTMLElement>('.modal-body') ?? list }; controls.start(event)
    }} onKeyDown={event => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault(); const index = ids.indexOf(row.id), target = index + (event.key === 'ArrowUp' ? -1 : 1)
      if (target < 0 || target >= ids.length) return
      const next = [...ids]; [next[index], next[target]] = [next[target]!, next[index]!]; onReorder(next)
    }}><GripVertical size={16} /></button>
    {onSelect ? <button type="button" disabled={disabled} className="sortable-select" aria-pressed={details ? undefined : selected} aria-expanded={details ? selected : undefined} onClick={() => onSelect(row.id)}><strong>{row.label}</strong>{row.detail && <small>{row.detail}</small>}</button> : <span className="sortable-select"><strong>{row.label}</strong>{row.detail && <small>{row.detail}</small>}</span>}
    {row.badge && <span className="sortable-badge">{row.badge}</span>}
    {actions?.(row.id)}
    {details && selected && <div className="sortable-details">{details(row.id)}</div>}
  </Reorder.Item>
}
