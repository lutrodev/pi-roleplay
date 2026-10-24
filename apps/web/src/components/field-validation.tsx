import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { CircleAlert } from 'lucide-react'
import { fieldValidationMessage } from '../lib/field-validation.ts'

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

export function useFieldValidation(value?: unknown) {
  const id = useId(), [error, setError] = useState('')
  const invalidControl = useRef<Control | null>(null)
  // Imports and other controlled updates bypass onChange, but must clear repaired errors.
  useEffect(() => { if (invalidControl.current?.validity.valid) setError('') }, [value])
  const message = (control: Control) => fieldValidationMessage(control.validity, control as HTMLInputElement)
  return {
    error,
    describedBy: (existing?: string) => [existing, error && id].filter(Boolean).join(' ') || undefined,
    invalid: (event: FormEvent<Control>) => {
      if (event.defaultPrevented) return
      event.preventDefault()
      const control = event.currentTarget
      invalidControl.current = control
      setError(message(control))
      const first = control.form && Array.from(control.form.elements).find(element => 'validity' in element && !(element as Control).validity.valid)
      if (!first || first === control) requestAnimationFrame(() => { if (control.isConnected) control.focus() })
    },
    changed: (control: Control) => { if (error) setError(message(control)) },
    feedback: error && <span className="field-validation" id={id} role="alert"><CircleAlert size={13} aria-hidden="true" /><span>{error}</span></span>,
  }
}
