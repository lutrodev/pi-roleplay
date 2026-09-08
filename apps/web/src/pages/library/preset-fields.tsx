import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, ChevronDown, Copy, GripVertical, Plus, Trash2, Undo2 } from 'lucide-react'
import type { JsonObject, JsonValue } from '../../../../../packages/rp-core/src/types.ts'
import { changePresetPosition, insertPresetField, moveEntry, reorderEntries } from '../../../../../packages/rp-core/src/lore/editing.ts'
import { Button, Field, IconButton, Input, Menu, MenuItem, Select, Textarea } from '../../components/ui.tsx'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { usePresetDrag } from './preset-drag.ts'

type FocusTarget = { id: string; field: 'name' | 'position' }
interface Props { entries: JsonObject[]; onChange: (entries: JsonObject[]) => void; disabled?: boolean }
const positions = ['top', 'bottom'] as const

export function PresetFields({ entries, onChange, disabled = false }: Props) {
  useUiLanguage()
  const [focus, setFocus] = useState<FocusTarget | null>(null), [removed, setRemoved] = useState<{ entry: JsonObject; nextId?: string } | null>(null)
  const jump = useRef<string | null>(null)
  const update = (id: string, key: string, value: JsonValue) => onChange(entries.map(entry => entry.id === id ? { ...entry, [key]: value } : entry))
  const add = () => {
    const entry = { id: crypto.randomUUID(), name: '', description: '', content: '', position: 'top', sectionTag: true }
    onChange(insertPresetField(entries, entry)); setFocus({ id: entry.id, field: 'name' })
  }
  const copy = (entry: JsonObject) => {
    const next = [...entries], copied = { ...structuredClone(entry), id: crypto.randomUUID(), name: uiT('%{v0}（副本）', { v0: String(entry.name ?? '') }) }
    next.splice(entries.findIndex(item => item.id === entry.id) + 1, 0, copied); onChange(next); setFocus({ id: copied.id, field: 'name' })
  }
  const remove = (entry: JsonObject) => {
    const index = entries.findIndex(item => item.id === entry.id), position = entry.position ?? 'top'
    const nextId = entries.slice(index + 1).find(item => (item.position ?? 'top') === position)?.id
    setRemoved({ entry: structuredClone(entry), nextId: typeof nextId === 'string' ? nextId : undefined })
    onChange(entries.filter(item => item.id !== entry.id))
  }
  const restore = () => {
    if (!removed) return
    const next = [...entries], at = next.findIndex(entry => entry.id === removed.nextId && (entry.position ?? 'top') === (removed.entry.position ?? 'top'))
    if (at < 0) onChange(insertPresetField(entries, removed.entry))
    else { next.splice(at, 0, removed.entry); onChange(next) }
    setFocus({ id: String(removed.entry.id), field: 'name' }); setRemoved(null)
  }
  return <section className="preset-fields stack" aria-label={uiT('预设字段')}>
    <div className="section-heading"><div><h3>{uiT('预设字段')} · {entries.length}</h3></div><div className="preset-field-tools"><Menu label={uiT('定位字段')} trigger={<Button disabled={!entries.length} className="preset-field-jump">{uiT('定位字段')}<ChevronDown size={14} /></Button>} onCloseAutoFocus={event => {
      if (!jump.current) return
      const card = [...document.querySelectorAll<HTMLElement>('[data-preset-field]')].find(element => element.dataset.presetField === jump.current)
      jump.current = null
      if (card) { event.preventDefault(); card.scrollIntoView({ block: 'start' }); card.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }) }
    }}>{entries.map((entry, index) => <MenuItem key={String(entry.id)} onSelect={() => { jump.current = String(entry.id) }}>{index + 1}. {String(entry.name || uiT('未命名'))}</MenuItem>)}</Menu><Button disabled={disabled} onClick={add}><Plus size={15} />{uiT('添加字段')}</Button></div></div>
    {removed && <div className="preset-undo" role="status"><span>{uiT('已移除%{v0}', { v0: String(removed.entry.name || uiT('新字段')) })}</span><Button tone="quiet" disabled={disabled} onClick={restore}><Undo2 size={15} />{uiT('撤销删除')}</Button></div>}
    {positions.map(position => <PresetGroup key={position} position={position} entries={entries} disabled={disabled} focus={focus} focused={() => setFocus(null)}
      update={update} copy={copy} remove={remove} reorder={ids => onChange(reorderEntries(entries, ids, true))}
      move={(id, by) => onChange(moveEntry(entries, entries.findIndex(entry => entry.id === id), by, true))}
      relocate={(id, destination) => { onChange(changePresetPosition(entries, id, destination)); setFocus({ id, field: 'position' }) }} />)}
  </section>
}

interface GroupProps {
  position: 'top' | 'bottom'; entries: JsonObject[]; disabled: boolean; focus: FocusTarget | null; focused: () => void
  update: (id: string, key: string, value: JsonValue) => void; copy: (entry: JsonObject) => void; remove: (entry: JsonObject) => void
  reorder: (ids: string[]) => void; move: (id: string, by: -1 | 1) => void; relocate: (id: string, position: 'top' | 'bottom') => void
}
function PresetGroup(props: GroupProps) {
  const { position, entries, disabled, reorder } = props, root = useRef<HTMLElement>(null)
  const fields = entries.filter(entry => (entry.position ?? 'top') === position), ids = fields.map(entry => String(entry.id))
  const { drag, start, announcement } = usePresetDrag({ root, ids, disabled, reorder })
  return <section ref={root} className="preset-group" aria-label={position === 'top' ? uiT('顶部字段') : uiT('底部字段')} data-preset-position={position}>
    <header className="preset-group-heading"><div><h4>{position === 'top' ? uiT('顶部') : uiT('底部')}</h4><p>{position === 'top' ? uiT('位于角色资料之前') : uiT('位于文风和重要规则之后')}</p></div><span>{uiT('%{count} 项', { count: fields.length })}</span></header>
    <div className="preset-field-list" data-drop-end={drag?.valid && drag.before === null || undefined}>
      {fields.map((entry, index) => <PresetCard key={String(entry.id)} {...props} entry={entry} index={index} count={fields.length} dragging={drag?.id === entry.id} dropBefore={!!drag?.valid && drag.before === entry.id} start={start} />)}
      {!fields.length && <p className="preset-group-empty">{uiT('暂无字段，可在字段的位置选项中移到这里。')}</p>}
    </div><span className="sr-only" aria-live="polite">{announcement}</span>
    {drag && createPortal(<div className="preset-drag-preview" aria-hidden="true" style={{ left: drag.x + 16, top: drag.y + 12 }}><GripVertical size={16} />{drag.label}</div>, document.body)}
  </section>
}
function PresetCard({ entry, index, count, dragging, dropBefore, start, ...props }: GroupProps & { entry: JsonObject; index: number; count: number; dragging: boolean; dropBefore: boolean; start: ReturnType<typeof usePresetDrag>['start'] }) {
  const card = useRef<HTMLElement>(null), id = String(entry.id), name = String(entry.name || uiT('新字段'))
  const move = (by: -1 | 1, trigger: HTMLButtonElement) => {
    props.move(id, by)
    requestAnimationFrame(() => {
      const target = trigger.disabled ? card.current?.querySelector<HTMLElement>('.sort-handle') : trigger
      target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' })
    })
  }
  useLayoutEffect(() => {
    if (props.focus?.id !== id) return
    const field = card.current?.querySelector<HTMLElement>(`[data-field="${props.focus.field}"]`)
    field?.focus({ preventScroll: true }); field?.scrollIntoView({ block: 'nearest' }); props.focused()
  }, [props.focus, id])
  return <article ref={card} className="preset-field-card" data-preset-field={id} data-dragging={dragging || undefined} data-drop-before={dropBefore || undefined} aria-label={uiT('预设字段：%{name}', { name })}>
    <header className="preset-card-heading">
      <button type="button" className="sort-handle" disabled={props.disabled} aria-label={uiT('拖动排序 %{v0}；上下方向键排序', { v0: name })} onPointerDown={event => start(event, id, name)} onKeyDown={event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault(); move(event.key === 'ArrowUp' ? -1 : 1, event.currentTarget)
      }}><GripVertical size={16} /></button><h5>{name}</h5>
      <div className="preset-card-actions"><span className="preset-tag-label">{uiT('分组标签')}</span><Button role="switch" aria-label={uiT('%{name}默认使用分组标签', { name })} aria-checked={entry.sectionTag !== false} className="preset-tag-switch" disabled={props.disabled} onClick={() => props.update(id, 'sectionTag', entry.sectionTag === false)}><span /></Button>
        <span className="preset-card-index">{index + 1}/{count}</span>
        <IconButton label={uiT('上移字段：%{name}', { name })} disabled={props.disabled || index === 0} onClick={event => move(-1, event.currentTarget)}><ArrowUp size={15} /></IconButton>
        <IconButton label={uiT('下移字段：%{name}', { name })} disabled={props.disabled || index === count - 1} onClick={event => move(1, event.currentTarget)}><ArrowDown size={15} /></IconButton>
        <IconButton label={uiT('复制字段：%{name}', { name })} disabled={props.disabled} onClick={() => props.copy(entry)}><Copy size={15} /></IconButton>
        <IconButton label={uiT('移除字段：%{name}', { name })} disabled={props.disabled} onClick={() => props.remove(entry)}><Trash2 size={15} /></IconButton>
      </div>
    </header>
    <div className="preset-card-meta">
      <Field label={uiT('位置')}><Select data-field="position" value={String(entry.position ?? 'top')} disabled={props.disabled} onChange={event => props.relocate(id, event.target.value as 'top' | 'bottom')}><option value="top">{uiT('顶部')}</option><option value="bottom">{uiT('底部')}</option></Select></Field>
      <Field label={uiT('名称')}><Input data-field="name" required disabled={props.disabled} value={String(entry.name ?? '')} onChange={event => props.update(id, 'name', event.target.value)} /></Field>
      <Field label={uiT('描述')}><Input disabled={props.disabled} value={String(entry.description ?? '')} onChange={event => props.update(id, 'description', event.target.value)} /></Field>
    </div>
    <Field label={uiT('内容')}><Textarea rows={5} disabled={props.disabled} value={String(entry.content ?? '')} onChange={event => props.update(id, 'content', event.target.value)} /></Field>
  </article>
}
