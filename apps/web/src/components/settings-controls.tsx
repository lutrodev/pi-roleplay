import { useId, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { SettingRow } from './settings-layout.tsx'

/** A simple toggle has a full-row label; optional actions remain separate hit targets. */
export function SettingToggle({ label, help, actions, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; help?: string; actions?: ReactNode }) {
  useUiLanguage()
  const id = useId()
  const control = <input {...props} id={id} aria-label={props['aria-label'] ?? label} aria-describedby={props['aria-describedby'] ?? (help ? `${id}-help` : undefined)} type="checkbox" role="switch" className="setting-switch" />
  return <SettingRow as={actions ? 'div' : 'label'} kind="toggle" className={actions ? 'setting-row-with-actions' : undefined} label={actions ? <label htmlFor={id}>{label}</label> : label} help={help} helpId={`${id}-help`}>{actions ? <label className="setting-switch-target">{control}</label> : control}{actions}</SettingRow>
}

/** Native radio navigation keeps Arrow keys and form disabling without a second state model. */
export function SegmentedSetting<T extends string>({ label, help, value, onChange, options }: {
  label: string; help?: string; value: T; onChange: (value: T) => void; options: readonly { value: T; label: string }[]
}) {
  const id = useId()
  return <SettingRow kind="segmented" label={label} labelId={id} help={help}><span className="segmented-control" role="radiogroup" aria-labelledby={id}>{options.map(option => <label key={option.value}><input type="radio" name={id} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} /><span>{uiT(option.label)}</span></label>)}</span></SettingRow>
}

export function SettingSlider({ label, value, min, max, step = 1, displayValue, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; displayValue: string; onChange: (value: number) => void
}) {
  const id = useId(), progress = Math.max(0, Math.min(100, (value - min) / (max - min) * 100))
  return <SettingRow kind="slider" label={<label htmlFor={id}>{label}</label>}><input id={id} type="range" className="setting-slider" aria-valuetext={displayValue} min={min} max={max} step={step} value={value} style={{ '--slider-progress': `${progress}%` } as CSSProperties} onChange={event => onChange(Number(event.target.value))} /><output htmlFor={id} className="setting-value" aria-hidden="true">{displayValue}</output></SettingRow>
}
