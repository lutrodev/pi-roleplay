import type { ChangeEventHandler, MouseEventHandler } from 'react'
import { Check, CornerDownLeft } from 'lucide-react'

interface ChoiceContent { number: number; label: string; description?: string }
type ChoiceProps = ChoiceContent & { disabled?: boolean } & (
  { kind: 'selection'; type: 'radio' | 'checkbox'; name: string; checked: boolean; onChange: ChangeEventHandler<HTMLInputElement> }
  | { kind: 'action'; onClick: MouseEventHandler<HTMLButtonElement> }
)

/** Shared presentation, with native semantics for selecting an answer or inserting a suggestion. */
export function ChoiceOption(props: ChoiceProps) {
  const content = <><span className="choice-option-number" aria-hidden="true">{props.number}</span><span className="choice-option-copy"><span>{props.label}</span>{props.description && <small>{props.description}</small>}</span></>
  if (props.kind === 'action') return <button type="button" className="choice-option choice-option-action" disabled={props.disabled} onClick={props.onClick}>
    {content}<CornerDownLeft className="choice-option-indicator" size={15} aria-hidden="true" />
  </button>
  return <label className={`choice-option${props.checked ? ' is-selected' : ''}`}>
    <input className="sr-only" type={props.type} name={props.name} checked={props.checked} disabled={props.disabled} onChange={props.onChange} />
    {content}<Check className="choice-option-indicator" size={16} aria-hidden="true" />
  </label>
}
