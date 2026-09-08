import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useId, useRef } from 'react'
import { Button, Textarea } from '../../components/ui.tsx'

export function PersonaDescription({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  useUiLanguage()
  const input = useRef<HTMLTextAreaElement>(null), id = useId()
  return <section className="persona-description"><label className="field-label" htmlFor={id}>{uiT('描述')}</label><div className="persona-description-surface"><Textarea id={id} appearance="plain" ref={input} rows={7} value={value} placeholder={uiT('写下你的身份、外貌和经历，也可以用下方标签快速补充。')} onChange={event => onChange(event.target.value)} /><div className="description-labels" role="group" aria-label={uiT('快捷补充')}><span>{uiT('快捷补充')}</span>{[uiT("身份"), uiT("性别"), uiT("年龄"), uiT("外貌"), uiT("性格"), uiT("说话方式"), uiT("背景故事"), uiT("爱好")].map(label => <Button key={label} tone="quiet" onMouseDown={event => { if (event.button === 0) event.preventDefault() }} onClick={() => {
    const start = input.current?.selectionStart ?? value.length, end = input.current?.selectionEnd ?? start
    const insertion = `${start > 0 && value[start - 1] !== '\n' ? '\n' : ''}${label}：`
    onChange(value.slice(0, start) + insertion + value.slice(end)); requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(start + insertion.length, start + insertion.length) })
  }}>{label}</Button>)}</div></div></section>
}
