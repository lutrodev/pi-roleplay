import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, Plus, Trash2, Undo2 } from 'lucide-react'
import type { JsonObject, JsonValue } from '../../../../../packages/rp-core/src/types.ts'
import { matchesEntry, orderEntries, reorderEntries } from '../../../../../packages/rp-core/src/lore/editing.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { Button, Check, Empty, Field, Input, Menu, MenuItem, Select, TabGroup, Textarea, TextListInput } from '../../components/ui.tsx'
import { SortableRows } from '../../components/sortable-rows.tsx'
import { ConditionEditor } from './condition.tsx'

const categories = [['worldDescription', '世界设定'], ['roleplayGuide', '扮演指导'], ['importantRules', '重要规则']] as const
export function LorebookEntries({ entries, onChange, disabled }: { entries: JsonObject[]; onChange: (entries: JsonObject[]) => void; disabled: boolean }) {
  useUiLanguage()
  const root = useRef<HTMLElement>(null), focus = useRef<string | null>(null)
  const [selected, select] = useState<string | null>(entries[0] ? String(entries[0].id) : null), [query, setQuery] = useState(''), [enabled, setEnabled] = useState('all')
  const [level, setLevel] = useState(String(entries[0]?.level ?? 'worldDescription')), [removed, setRemoved] = useState<{ entry: JsonObject; index: number } | null>(null)
  const entry = entries.find(item => item.id === selected)
  // Keep the field being edited visible even if its name or enabled state stops matching the filter.
  const visible = entries.filter(item => (item.level ?? 'worldDescription') === level && (item.id === selected || matchesEntry(item, query, enabled, '')))
  const ids = visible.map(item => String(item.id))
  const open = (id: string) => { select(id); focus.current = id }
  const focusEditor = () => {
    if (!focus.current) return
    const field = root.current?.querySelector<HTMLElement>(`[data-lore-editor="${CSS.escape(focus.current)}"] input`)
    if (field) { field.focus({ preventScroll: true }); field.scrollIntoView({ block: 'nearest' }); focus.current = null }
  }
  useLayoutEffect(() => { if (!document.querySelector('[role="menu"]')) focusEditor() }, [selected, entries.length, level])
  const patch = (id: string, key: string, value: JsonValue | undefined) => onChange(entries.map(item => {
    if (item.id !== id) return item
    const next = { ...item }; if (value === undefined) delete next[key]; else next[key] = value; return next
  }))
  const update = (key: string, value: JsonValue | undefined) => { if (selected) patch(selected, key, value) }
  const add = () => {
    const item = { id: crypto.randomUUID(), name: '', content: '', level, keys: [], secondaryKeys: [], enabled: true, constant: true, recursive: true }
    onChange(orderEntries([...entries, item])); setQuery(''); setEnabled('all'); open(item.id)
  }
  const copy = (item: JsonObject) => {
    const next = [...entries], copied = { ...structuredClone(item), id: crypto.randomUUID(), name: uiT('%{v0}（副本）', { v0: String(item.name ?? '') }) }
    next.splice(entries.indexOf(item) + 1, 0, copied); onChange(orderEntries(next)); open(copied.id)
  }
  const remove = (item: JsonObject) => {
    setRemoved({ entry: structuredClone(item), index: entries.indexOf(item) }); onChange(orderEntries(entries.filter(value => value.id !== item.id)))
    if (selected === item.id) select(null)
  }
  const move = (id: string, by: -1 | 1) => {
    const index = ids.indexOf(id), target = index + by
    if (target < 0 || target >= ids.length) return
    const next = [...ids]; [next[index], next[target]] = [next[target]!, next[index]!]; onChange(reorderEntries(entries, next))
  }
  return <section ref={root} className="lorebook-entries stack" aria-label={uiT('世界书条目')}>
    <div className="section-heading"><h3>{uiT('世界书条目')} · {entries.length}</h3><Button disabled={disabled} onClick={add}><Plus size={15} />{uiT('添加条目')}</Button></div>
    {removed && <div className="preset-undo" role="status"><span>{uiT('已移除%{v0}', { v0: String(removed.entry.name || uiT('新条目')) })}</span><Button onClick={() => {
      const next = [...entries]; next.splice(Math.min(removed.index, next.length), 0, removed.entry); onChange(orderEntries(next)); setLevel(String(removed.entry.level ?? 'worldDescription')); setQuery(''); setEnabled('all'); open(String(removed.entry.id)); setRemoved(null)
    }}><Undo2 size={15} />{uiT('撤销删除')}</Button></div>}
    <div className="form-grid"><Field label={uiT('搜索条目')}><Input value={query} placeholder={uiT('名称、关键词或正文')} onChange={event => { setQuery(event.target.value); select(null) }} /></Field><Field label={uiT('启用状态')}><Select value={enabled} onChange={event => { setEnabled(event.target.value); select(null) }}><option value="all">{uiT('全部')}</option><option value="enabled">{uiT('已启用')}</option><option value="disabled">{uiT('已停用')}</option></Select></Field></div>
    <TabGroup label={uiT('世界书条目分类')} value={level} onChange={next => { setLevel(next); select(null) }} items={categories.map(([value, label]) => ({ value, label: `${uiT(label)} · ${entries.filter(item => (item.level ?? 'worldDescription') === value).length}` }))}>
      <SortableRows label={uiT('条目排序')} className="inline-entry-rows" rows={visible.map(item => ({ id: String(item.id), label: String(item.name || uiT('新条目')), detail: String(item.content ?? '').slice(0, 100), badge: item.constant ? uiT('常驻') : uiT('条件触发') }))} selected={selected ?? undefined} disabled={disabled}
        onSelect={id => selected === id ? select(null) : open(id)} onReorder={order => onChange(reorderEntries(entries, order))}
        actions={id => { const item = entries.find(entry => entry.id === id)!, name = String(item.name || uiT('新条目')), index = ids.indexOf(id); return <div className="lore-row-actions"><Check label={uiT('启用')} aria-label={uiT('启用条目：%{name}', { name })} checked={item.enabled !== false} disabled={disabled} onChange={event => patch(id, 'enabled', event.target.checked)} /><Menu label={uiT('%{v0}的操作', { v0: name })} onCloseAutoFocus={event => { if (focus.current) { event.preventDefault(); focusEditor() } }}><MenuItem disabled={disabled || index === 0} onSelect={() => move(id, -1)}><ArrowUp size={15} />{uiT('上移条目')}</MenuItem><MenuItem disabled={disabled || index === ids.length - 1} onSelect={() => move(id, 1)}><ArrowDown size={15} />{uiT('下移条目')}</MenuItem><MenuItem disabled={disabled} onSelect={() => copy(item)}><Copy size={15} />{uiT('复制条目')}</MenuItem><MenuItem disabled={disabled} danger onSelect={() => remove(item)}><Trash2 size={15} />{uiT('移除')}</MenuItem></Menu></div> }}
        details={() => entry && <div className="stack" data-lore-editor={String(entry.id)}><Field label={uiT('条目名称')}><Input required value={String(entry.name ?? '')} onChange={event => update('name', event.target.value)} /></Field><Field label={uiT('条目内容')}><Textarea rows={6} required value={String(entry.content ?? '')} onChange={event => update('content', event.target.value)} /></Field>
      <><Field label={uiT("用途层级")}><Select value={String(entry.level ?? 'worldDescription')} onChange={event => { update('level', event.target.value); setLevel(event.target.value); setQuery(''); setEnabled('all'); focus.current = selected }}><option value="worldDescription">{uiT("世界设定")}</option><option value="roleplayGuide">{uiT("角色与扮演指导")}</option><option value="importantRules">{uiT("重要规则")}</option></Select></Field><div className="inline-checks">{[['enabled', uiT("启用")], ['constant', uiT("常驻")], ['caseSensitive', uiT("区分大小写")], ['recursive', uiT("参与递归激活")]].map(([key, label]) => <Check key={key} label={label!} checked={entry[key!] === true} onChange={event => update(key!, event.target.checked)} />)}</div>{[['keys', uiT("主关键词")], ['secondaryKeys', uiT("次关键词")]].map(([key, label]) => <Field key={key} label={label!} help={uiT("以逗号分隔")}><TextListInput key={String(entry.id) + key} value={(entry[key!] ?? []) as string[]} onChange={items => update(key!, items)} /></Field>)}<details className="lore-condition"><summary>{uiT("变量条件（可选）")}{entry.stateCondition ? uiT(" · 已设置") : ''}</summary><ConditionEditor key={String(entry.id)} value={String(entry.stateCondition ?? '')} onChange={value => update('stateCondition', value || undefined)} /></details><details><summary>{uiT("高级激活设置")}</summary><div className="stack"><Field label={uiT("语义标识（可选）")}><Input value={String(entry.semanticKey ?? '')} onChange={event => update('semanticKey', event.target.value || undefined)} /></Field>{[['order', uiT("排序值")], ['position', uiT("位置值")], ['depth', uiT("插入深度")], ['probability', uiT("触发概率（0–1）")]].map(([key, label]) => <Field key={key} label={label!}><Input type="number" min={key === 'probability' ? 0 : undefined} max={key === 'probability' ? 1 : undefined} step={key === 'probability' ? 0.01 : 1} value={typeof entry[key!] === 'number' ? Number(entry[key!]) : ''} onChange={event => update(key!, event.target.value === '' ? undefined : Number(event.target.value))} /></Field>)}<Field label={uiT("社区格式插入位置")}><Select value={String(entry.insertionPosition ?? '')} onChange={event => update('insertionPosition', event.target.value || undefined)}><option value="">{uiT("默认")}</option>{['before_char', 'after_char', 'before_examples', 'after_examples', 'in_chat', 'before_an', 'after_an'].map(value => <option key={value}>{value}</option>)}</Select></Field></div></details></>
      </div>} />
      {!visible.length && <Empty title={uiT('没有符合条件的条目')} action={<Button onClick={() => { setQuery(''); setEnabled('all') }}>{uiT('清空筛选')}</Button>}>{uiT('可以调整筛选，或在当前分类添加条目。')}</Empty>}
    </TabGroup>
  </section>
}
