import type { CSSProperties } from 'react'
import type { DialogueColor, ItalicColor } from '../../../../packages/rp-core/src/settings/preferences.ts'

export interface ReadingColor { label: string; light: string; dark: string }

/** Text colors chosen for both reading canvases, including user-message surfaces. */
export const DIALOGUE_PALETTE = {
  orange: { label: '橙色', light: '#ad4f08', dark: '#fdba74' },
  green: { label: '绿色', light: '#486456', dark: '#b0c6b7' },
  blue: { label: '蓝色', light: '#3467a8', dark: '#93c5fd' },
  purple: { label: '紫色', light: '#7856a8', dark: '#c4b5fd' },
  rose: { label: '玫红', light: '#ae4664', dark: '#f4a5bf' },
} satisfies Record<DialogueColor, ReadingColor>

export const ITALIC_PALETTE = {
  teal: { label: '青碧', light: '#246b70', dark: '#86cbd0' },
  indigo: { label: '靛青', light: '#5262a0', dark: '#aebbf0' },
  plum: { label: '梅紫', light: '#805276', dark: '#d7aecf' },
  olive: { label: '橄榄', light: '#65652f', dark: '#c9cd91' },
  slate: { label: '蓝灰', light: '#586776', dark: '#b1c2d3' },
} satisfies Record<ItalicColor, ReadingColor>

export function dialogueColorStyle(color: DialogueColor): CSSProperties {
  return { '--dialogue-light': DIALOGUE_PALETTE[color].light, '--dialogue-dark': DIALOGUE_PALETTE[color].dark } as CSSProperties
}

export function italicColorStyle(color: ItalicColor, enabled: boolean): CSSProperties {
  // `initial` makes the custom property invalid, allowing each selector's own color fallback.
  return { '--italic-light': ITALIC_PALETTE[color].light, '--italic-dark': ITALIC_PALETTE[color].dark, '--italic-ink': enabled ? 'var(--italic)' : 'initial' } as CSSProperties
}
