import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Plus, RotateCcw, Trash2, Undo2 } from 'lucide-react'
import type { Preferences } from '../../../../../packages/rp-core/src/settings/preferences.ts'
import { DEFAULT_QUICK_REPLIES, insertQuickReply, MAX_QUICK_REPLIES, MAX_QUICK_REPLY_LABEL_CHARACTERS, MAX_QUICK_REPLY_CONTENT_CHARACTERS } from '../../../../../packages/rp-core/src/interaction/quick-replies.js'
import { SettingToggle } from '../../components/settings-controls.tsx'
import { Button, Field, Input, Menu, MenuItem, MenuSeparator, Select, Textarea } from '../../components/ui.tsx'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'

type QuickReply = Preferences['quickReplies'][number]
type Undo = { entries: QuickReply[]; removedId?: string; nextId?: string }

export function QuickReplySettings({ value, onChange }: {
  value: Pick<Preferences, 'quickReplies' | 'quickRepliesEnabled'>
  onChange: (value: Partial<Pick<Preferences, 'quickReplies' | 'quickRepliesEnabled'>>) => void
}) {
  useUiLanguage()
  const replies = value.quickReplies
  const root = useRef<HTMLElement>(null), addButton = useRef<HTMLButtonElement>(null)
  const localReplies = useRef(replies)
  const focus = useRef<{ id?: string; edit?: boolean } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [undo, setUndo] = useState<Undo | null>(null)

  useLayoutEffect(() => {
    // Saving or discarding replaces the draft; its previous undo must not restore stale entries.
    if (localReplies.current !== replies) setUndo(null)
    localReplies.current = replies
    if (!focus.current) return
    const { id, edit } = focus.current
    const details = id ? root.current?.querySelector<HTMLDetailsElement>(`[data-quick-reply="${CSS.escape(id)}"] details`) : null
    if (details && edit) details.open = true
    const target = details?.querySelector<HTMLElement>(edit ? 'input' : 'summary') ?? addButton.current
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest' })
    focus.current = null
  }, [replies])

  const changeReplies = (next: QuickReply[]) => {
    localReplies.current = next
    onChange({ quickReplies: next })
  }
  const clearResetUndo = () => { if (undo && !undo.removedId) setUndo(null) }
  const update = (id: string, patch: Partial<QuickReply>) => {
    clearResetUndo()
    changeReplies(replies.map(reply => reply.id === id ? { ...reply, ...patch } : reply))
  }
  const move = (index: number, by: number) => {
    clearResetUndo()
    const next = [...replies]
    ;[next[index], next[index + by]] = [next[index + by]!, next[index]!]
    changeReplies(next)
  }
  const remove = (index: number) => {
    const reply = replies[index]!
    setUndo({ entries: structuredClone(replies), removedId: reply.id, nextId: replies[index + 1]?.id })
    focus.current = { id: replies[index + 1]?.id ?? replies[index - 1]?.id }
    if (editing === reply.id) setEditing(null)
    changeReplies(replies.filter(item => item.id !== reply.id))
  }
  const undoAtLimit = Boolean(undo?.removedId && replies.length >= MAX_QUICK_REPLIES)
  const restore = () => {
    if (!undo || undoAtLimit) return
    let next = undo.entries
    if (undo.removedId) {
      const entry = undo.entries.find(item => item.id === undo.removedId)!
      next = [...replies]
      const at = next.findIndex(item => item.id === undo.nextId)
      next.splice(at < 0 ? next.length : at, 0, entry)
      focus.current = { id: entry.id, edit: true }
      setEditing(entry.id)
    }
    changeReplies(next)
    setUndo(null)
  }

  return <section ref={root} className="quick-reply-settings">
    <SettingToggle label={uiT('在输入框显示快捷按钮')} help={uiT('关闭后仍可编辑，已有配置会保留。')} checked={value.quickRepliesEnabled} onChange={event => onChange({ quickRepliesEnabled: event.target.checked })} />
    <div className="quick-reply-toolbar">
      <h3>{uiT('快捷按钮')} <span>{replies.length} / {MAX_QUICK_REPLIES}</span></h3>
      <div className="quick-reply-toolbar-actions">
        <Button tone="quiet" onClick={() => {
          setUndo({ entries: structuredClone(replies) })
          setEditing(null)
          changeReplies(DEFAULT_QUICK_REPLIES.map(item => ({ ...item })))
        }}><RotateCcw size={14} />{uiT('恢复默认')}</Button>
        <Button ref={addButton} disabled={replies.length >= MAX_QUICK_REPLIES} onClick={() => {
          clearResetUndo()
          const id = crypto.randomUUID()
          focus.current = { id, edit: true }
          setEditing(id)
          changeReplies([...replies, { id, label: '', content: '', cursorPosition: 'end' }])
        }}><Plus size={15} />{uiT('添加')}</Button>
      </div>
    </div>
    {undo && <div className="preset-undo quick-reply-undo" role="status"><span>{uiT(undoAtLimit ? '已达按钮数量上限，无法撤销这次移除。' : undo.removedId ? '已移除快捷按钮' : '已恢复默认快捷按钮')}</span><Button tone="quiet" disabled={undoAtLimit} onClick={restore}><Undo2 size={14} />{uiT('撤销')}</Button></div>}
    <div className="quick-reply-list">
      {!replies.length && <p className="quick-reply-empty">{uiT('还没有快捷按钮。添加常用文字或符号，下次输入时一键插入。')}</p>}
      {replies.map((reply, index) => <div className="quick-reply-row" key={reply.id} data-quick-reply={reply.id}>
        <details open={editing === reply.id} onToggle={event => {
          if (event.currentTarget.open) setEditing(reply.id)
          else setEditing(current => current === reply.id ? null : current)
        }}>
          <summary aria-label={uiT('编辑快捷按钮：%{name}', { name: reply.label || uiT('未命名快捷回复') })}>
            <span className="quick-reply-chip">{reply.label || uiT('未命名快捷回复')}</span>
            <span className="quick-reply-excerpt">{!reply.content ? uiT('填写点击后插入的内容') : reply.content !== reply.label ? reply.content : uiT(reply.cursorPosition === 'middle' ? '光标停在中间' : '光标停在末尾')}</span>
            <ChevronRight className="quick-reply-chevron" size={15} />
          </summary>
          <div className="quick-reply-fields">
            <div className="quick-reply-field-pair">
              <Field label={uiT('按钮文字')}><Input required maxLength={MAX_QUICK_REPLY_LABEL_CHARACTERS} placeholder={uiT('例如：继续')} value={reply.label} onChange={event => update(reply.id, { label: event.target.value })} /></Field>
              <Field label={uiT('光标位置')}><Select value={reply.cursorPosition} onChange={event => update(reply.id, { cursorPosition: event.target.value as 'middle' | 'end' })}><option value="end">{uiT('末尾')}</option><option value="middle">{uiT('中间')}</option></Select></Field>
            </div>
            <Field label={uiT('插入内容')}><Textarea required rows={2} maxLength={MAX_QUICK_REPLY_CONTENT_CHARACTERS} placeholder={uiT('点击按钮时，插入到输入框的文字')} value={reply.content} onChange={event => update(reply.id, { content: event.target.value })} /></Field>
            <QuickReplyPreview reply={reply} />
          </div>
        </details>
        <div className="quick-reply-row-actions"><Menu label={uiT('快捷按钮操作：%{name}', { name: reply.label || uiT('未命名快捷回复') })}>
          <MenuItem disabled={!index} onSelect={() => move(index, -1)}><ArrowUp size={15} />{uiT('上移快捷回复')}</MenuItem>
          <MenuItem disabled={index === replies.length - 1} onSelect={() => move(index, 1)}><ArrowDown size={15} />{uiT('下移快捷回复')}</MenuItem>
          <MenuSeparator />
          <MenuItem danger onSelect={() => remove(index)}><Trash2 size={15} />{uiT('移除快捷回复')}</MenuItem>
        </Menu></div>
      </div>)}
    </div>
  </section>
}

/** Use the composer's insertion rules, including paired symbols and Unicode caret offsets. */
function QuickReplyPreview({ reply }: { reply: QuickReply }) {
  const preview = insertQuickReply('', reply.content, { start: 0, end: 0 }, reply.cursorPosition)
  const before = [...preview.text.slice(0, preview.selection.start)]
  const after = [...preview.text.slice(preview.selection.start)]
  return <div className="quick-reply-preview">
    <span>{uiT('插入效果')}</span>
    <span className="quick-reply-preview-text">{before.length > 30 && '…'}{before.slice(-30).join('')}<i className="quick-reply-caret" aria-hidden="true" /><span className="sr-only">{uiT('光标')}</span>{after.slice(0, 30).join('')}{after.length > 30 && '…'}</span>
    <small>{uiT('竖线表示光标位置')}</small>
  </div>
}
