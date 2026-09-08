import { useId, useRef, useState } from 'react'
import { ArrowRight, ChevronLeft, PencilLine, X } from 'lucide-react'
import type { QuestionAnswer, UserQuestion } from '../../../../../packages/rp-core/src/types.ts'
import { api, refreshStory, useAction } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { useAutosizeTextarea } from '../../lib/use-autosize-textarea.ts'
import { ErrorNotice, Button, IconButton, Textarea } from '../../components/ui.tsx'

import { ChoiceOption } from '../../components/choice-option.tsx'

export function Questions({ storyId, question }: { storyId: string; question: UserQuestion }) {
  useUiLanguage()
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() => question.questions.map(item => ({ id: item.id, selected: [], custom: '' })))
  const [step, setStep] = useState(0), [expanded, setExpanded] = useState<string[]>([]), action = useAction()
  const input = useRef<HTMLTextAreaElement>(null), heading = useRef<HTMLHeadingElement>(null), titleId = useId(), customId = useId()
  const item = question.questions[step]!, answer = answers[step]!, total = question.questions.length
  const customOpen = !item.options.length || expanded.includes(item.id), valid = !!answer.selected.length || !!answer.custom?.trim()
  const update = (next: Partial<QuestionAnswer>) => setAnswers(values => values.map((value, index) => index === step ? { ...value, ...next } : value))
  const reveal = () => heading.current?.closest('form')?.scrollIntoView({ block: 'nearest' })
  const move = (next: number) => { setStep(next); requestAnimationFrame(() => { heading.current?.focus({ preventScroll: true }); reveal() }) }
  useAutosizeTextarea(input, answer.custom ?? '', 48, 112, .2, customOpen)
  return <form className="question-card" aria-labelledby={titleId} onSubmit={event => {
    event.preventDefault()
    if (action.busy || !valid) return
    if (step < total - 1) { move(step + 1); return }
    const missing = answers.findIndex(value => !value.selected.length && !value.custom?.trim())
    if (missing >= 0) { move(missing); return }
    void action.run(async () => {
      await api(`/stories/${storyId}/questions/${question.id}/answer`, 'POST', { answers: answers.map(value => ({ id: value.id, selected: value.selected, ...(value.custom?.trim() ? { custom: value.custom.trim() } : {}) })) })
      await refreshStory(storyId)
    })
  }}>
    <header className="question-card-heading"><div>{item.header && <span className="question-context">{item.header}</span>}<h3 id={titleId} ref={heading} tabIndex={-1}>{item.question}</h3>{item.multiSelect && <span className="question-context">{uiT('可多选')}</span>}</div></header>
    {!!item.options.length && <fieldset className="choice-list" aria-labelledby={titleId} disabled={action.busy}>
      {item.options.map((option, index) => {
        const checked = answer.selected.includes(option.label)
        return <ChoiceOption key={option.label} kind="selection" number={index + 1} label={option.label} description={option.description}
          type={item.multiSelect ? 'checkbox' : 'radio'} name={`${question.id}-${item.id}`} checked={checked}
          onChange={event => update({ selected: item.multiSelect ? event.target.checked ? [...answer.selected, option.label] : answer.selected.filter(label => label !== option.label) : [option.label] })} />
      })}
    </fieldset>}
    {customOpen && <div className="question-custom"><label className="sr-only" htmlFor={customId}>{uiT('自己的回答或补充说明')}</label><Textarea id={customId} ref={input} rows={2} maxLength={20000} disabled={action.busy} value={answer.custom ?? ''} placeholder={answer.selected.length ? uiT('补充你的想法…') : uiT('写下你的回答…')} onChange={event => update({ custom: event.target.value })} />{!!item.options.length && <IconButton label={uiT('收起回答')} disabled={action.busy} onClick={() => setExpanded(values => values.filter(id => id !== item.id))}><X size={14} /></IconButton>}</div>}
    <ErrorNotice error={action.error} title={uiT('回答未提交')} />
    <footer className="question-card-footer"><div>{!!item.options.length && !customOpen && <Button tone="quiet" className="question-custom-toggle" disabled={action.busy} onClick={() => { setExpanded(values => [...values, item.id]); requestAnimationFrame(() => { input.current?.focus({ preventScroll: true }); reveal() }) }}><PencilLine size={14} />{answer.custom?.trim() ? uiT('编辑补充回答') : answer.selected.length ? uiT('补充说明') : uiT('自己回答')}</Button>}</div>
      <div className="question-navigation">{total > 1 && <><small aria-label={uiT('问题进度')}>{step + 1} / {total}</small>{step > 0 && <IconButton label={uiT('上一个问题')} disabled={action.busy} onClick={() => move(step - 1)}><ChevronLeft size={16} /></IconButton>}</>}<Button tone="primary" type="submit" disabled={action.busy || !valid}>{action.busy ? uiT('正在继续…') : uiT('继续')}<ArrowRight size={15} /></Button></div>
    </footer>
  </form>
}
