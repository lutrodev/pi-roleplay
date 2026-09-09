import { useId, type CSSProperties } from 'react'
import { Check } from 'lucide-react'
import { uiT } from '../lib/i18n.ts'
import type { ReadingColor } from '../lib/reading-colors.ts'
import { SettingsGroup } from './settings-layout.tsx'
import { SettingToggle } from './settings-controls.tsx'

export function ReadingHighlightControls<Color extends string>({ title, label, help, colorLabel, enabled, color, colors, palette, theme, onToggle, onColor }: {
  title: string; label: string; help: string; colorLabel: string; enabled: boolean
  color: Color; colors: readonly Color[]; palette: Record<Color, ReadingColor>; theme: 'light' | 'dark'
  onToggle: (enabled: boolean) => void; onColor: (color: Color) => void
}) {
  const id = useId()
  return <SettingsGroup title={title}>
    <SettingToggle label={label} help={help} checked={enabled} onChange={event => onToggle(event.target.checked)} />
    <fieldset className="highlight-color-options" disabled={!enabled}>
      <legend id={id}>{colorLabel}</legend>
      <div className="highlight-color-palette" role="radiogroup" aria-labelledby={id}>{colors.map(option => <label key={option}>
        <input type="radio" name={id} value={option} checked={color === option} onChange={() => onColor(option)} />
        <span className="highlight-color-option"><i aria-hidden="true" style={{ '--swatch-color': palette[option][theme] } as CSSProperties} /><span>{uiT(palette[option].label)}</span><Check className="highlight-color-check" size={12} aria-hidden="true" /></span>
      </label>)}</div>
    </fieldset>
  </SettingsGroup>
}
