import type { CSSProperties } from 'react'
import type { DialogueColor } from '../../../../packages/rp-core/src/settings/preferences.ts'

/** Text colors chosen for both reading canvases, including user-message surfaces. */
export const DIALOGUE_PALETTE = {
  orange: { label: '橙色', light: '#ad4f08', dark: '#fdba74' },
  green: { label: '绿色', light: '#486456', dark: '#b0c6b7' },
  blue: { label: '蓝色', light: '#3467a8', dark: '#93c5fd' },
  purple: { label: '紫色', light: '#7856a8', dark: '#c4b5fd' },
  rose: { label: '玫红', light: '#ae4664', dark: '#f4a5bf' },
} satisfies Record<DialogueColor, { label: string; light: string; dark: string }>

export function dialogueColorStyle(color: DialogueColor): CSSProperties {
  return { '--dialogue-light': DIALOGUE_PALETTE[color].light, '--dialogue-dark': DIALOGUE_PALETTE[color].dark } as CSSProperties
}
