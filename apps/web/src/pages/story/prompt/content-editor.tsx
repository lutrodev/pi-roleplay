import { ArrowLeft } from 'lucide-react'
import type { ContextSlot } from '../../../../../../packages/rp-core/src/types.ts'
import type { PromptBuild } from '../../../../../../packages/rp-core/src/context/preview.ts'
import { Button, Field, Input, Textarea } from '../../../components/ui.tsx'
import { uiT, useUiLanguage } from '../../../lib/i18n.ts'
import { formatPromptCount } from './cards.tsx'

export function PromptContentEditor({ slot, build, disabled, mobile, onChange, back }: {
  slot: ContextSlot; build: PromptBuild; disabled: boolean; mobile: boolean
  onChange: (build: PromptBuild) => void; back: () => void
}) {
  useUiLanguage()
  const content = build.customSources?.find(item => item.slotId === slot.id)?.content ?? ''
  return <aside className="prompt-preview-pane prompt-editing-pane">
    <header><div><small>{uiT('自定义资料')}</small><h3>{uiT('编辑分组内容')}</h3></div>
      <Button onClick={back}><ArrowLeft size={15} />{mobile ? uiT('返回编排') : uiT('返回预览')}</Button>
    </header>
    <p className="prompt-help">{uiT('内容只属于当前会话，保存后从下一次回复开始生效。空内容不会发送。')}</p>
    <div className="prompt-custom-form" data-prompt-scroll={!mobile || undefined}>
      <Field label={uiT('分组名称')}><Input autoFocus required maxLength={80} disabled={disabled} value={slot.label}
        onChange={event => onChange({ ...build, slots: build.slots.map(item => item.id === slot.id ? { ...item, label: event.target.value } : item) })} /></Field>
      <Field label={uiT('资料内容')}><Textarea rows={14} disabled={disabled} value={content} onChange={event => {
        const text = event.target.value, id = `rp.custom:${slot.id}`
        onChange({ ...build, slots: build.slots.map(item => item.id === slot.id ? { ...item, sourceIds: text.trim() ? item.sourceIds.includes(id) ? item.sourceIds : [...item.sourceIds, id] : item.sourceIds.filter(sourceId => sourceId !== id) } : item),
          customSources: [...(build.customSources ?? []).filter(item => item.slotId !== slot.id), ...(text.trim() ? [{ slotId: slot.id, content: text }] : [])] })
      }} /></Field>
      <p className="prompt-help">{formatPromptCount([...content].length)} {uiT(' 字符')}</p>
    </div>
  </aside>
}
