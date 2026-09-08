import { StatusNotice } from '../components/status-notice.tsx'
import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookOpen, Check, ChevronDown, MessageSquare, PencilLine } from 'lucide-react'
import type { AssetRecord, StoryProfile } from '../../../../packages/rp-core/src/types.ts'
import { expandRoleplayMacros } from '../../../../packages/rp-core/src/macro/syntax.js'
import { inspectMvuOpening } from '../../../../packages/rp-core/src/mvu/convert.js'
import { Markdown } from '../components/markdown.tsx'
import { Button, Field, Textarea } from '../components/ui.tsx'
import { uiT } from '../lib/i18n.ts'
import { cardOpenings } from './new-story-state.ts'
import { useAutosizeTextarea } from '../lib/use-autosize-textarea.ts'

export function NewStoryOpening({ scene, card, userName, compatMvu, onChange }: {
  scene: StoryProfile['scene']; card?: AssetRecord; userName: string; compatMvu: boolean; onChange: (scene: StoryProfile['scene']) => void
}) {
  const name = useId(), openings = cardOpenings(card?.data), selected = openings.find(item => item.index === (scene.openingIndex ?? 0))
  const input = useRef<HTMLTextAreaElement>(null)
  useAutosizeTextarea(input, scene.openingText ?? '', 120, 300, .4, scene.openingSource === 'custom')
  const modes = [
    { value: 'card', label: '角色卡开场', help: '选一段开场，接着写下去', icon: BookOpen, disabled: !openings.length },
    { value: 'custom', label: '自己写开场', help: '设定这一幕的起点', icon: PencilLine },
    { value: 'skip', label: '直接对话', help: '从我的第一条消息开始', icon: MessageSquare },
  ] as const
  const preview = scene.openingSource === 'custom' ? scene.openingText : selected?.text
  const previewText = useMemo(() => expandRoleplayMacros(compatMvu ? inspectMvuOpening(preview ?? '').text : preview ?? '', { characterName: card?.name, userName }), [preview, compatMvu, card?.name, userName])
  return <div className="new-story-opening">
    <div className="opening-modes" role="radiogroup" aria-label={uiT('开场方式')}>{modes.map(mode => <label key={mode.value} className="opening-mode" data-selected={scene.openingSource === mode.value}>
      <input type="radio" name={name} value={mode.value} checked={scene.openingSource === mode.value} disabled={'disabled' in mode && mode.disabled} onChange={() => onChange({ ...scene, openingSource: mode.value, ...(mode.value === 'card' ? { openingIndex: selected?.index ?? openings[0]?.index ?? 0 } : {}) })} />
      <mode.icon size={18} aria-hidden="true" /><span><strong>{uiT(mode.label)}</strong><small>{uiT(mode.help)}</small></span><Check className="opening-mode-check" size={15} aria-hidden="true" />
    </label>)}</div>
    {scene.openingSource === 'card' && <>
      {openings.length > 1 && <div className="opening-choices" role="group" aria-label={uiT('选择开场')}>{openings.map(item => <Button key={item.index} aria-pressed={selected?.index === item.index} tone="quiet" onClick={() => onChange({ ...scene, openingIndex: item.index })}>{item.index === 0 ? uiT('默认开场') : uiT('备用开场 %{count}', { count: item.index })}</Button>)}</div>}
      {!selected && <StatusNotice compact title={uiT('这张角色卡没有开场白')}><p>{uiT('可以自己写开场，或从第一条消息开始对话。')}</p></StatusNotice>}
    </>}
    {scene.openingSource === 'custom' && <Field label={uiT('开场正文')} help={uiT('支持 {{char}} 和 {{user}}，会替换为角色与我的人设名称。')}><Textarea ref={input} autoFocus required rows={4} maxLength={100000} value={scene.openingText ?? ''} placeholder={uiT('故事发生在哪里？此刻，谁正准备说第一句话？')} onChange={event => onChange({ ...scene, openingText: event.target.value })} /></Field>}
    {scene.openingSource !== 'skip' && !!preview?.trim() && <OpeningPreview key={scene.openingSource} initiallyOpen={scene.openingSource === 'card'} name={card?.name}>{previewText ? <Markdown text={previewText} /> : <p className="muted">{uiT('这个开场只包含变量初始化，创建后即可直接输入。')}</p>}</OpeningPreview>}
    {scene.openingSource === 'skip' && <div className="opening-skip"><MessageSquare size={26} strokeWidth={1.3} /><h3>{uiT('准备好就开始')}</h3><p>{uiT('角色与资料会随会话一起使用，开场留给你。')}</p></div>}
  </div>
}

function OpeningPreview({ initiallyOpen, name, children }: { initiallyOpen: boolean; name?: string; children: ReactNode }) {
  const [open, setOpen] = useState(initiallyOpen)
  return <details className="new-opening-preview" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary className="opening-preview-heading"><strong>{uiT('开场预览')}</strong><span>{name}</span><ChevronDown size={14} aria-hidden="true" /></summary><div>{children}</div></details>
}
