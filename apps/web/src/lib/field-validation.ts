import { uiT } from './i18n.ts'

type Constraints = { type?: string; min?: string; max?: string; minLength?: number; validationMessage?: string }

/** Localized feedback while retaining HTML's actual validation rules. */
export function fieldValidationMessage(validity: ValidityState, control: Constraints): string {
  if (validity.valid) return ''
  if (validity.customError) return control.validationMessage || uiT('请检查填写内容。')
  if (validity.valueMissing) return uiT('请填写这一项。')
  if (validity.typeMismatch) return uiT(control.type === 'email' ? '请输入有效的邮箱地址。' : '请输入完整的网址，例如 https://example.com。')
  if (validity.badInput) return uiT('请输入有效的数字。')
  if (validity.rangeUnderflow) return uiT('不能小于 %{value}。', { value: control.min ?? '' })
  if (validity.rangeOverflow) return uiT('不能大于 %{value}。', { value: control.max ?? '' })
  if (validity.tooShort) return uiT('至少需要 %{value} 个字符。', { value: control.minLength ?? 0 })
  if (validity.stepMismatch) return uiT('请输入符合步长的数值。')
  return uiT('请按要求的格式填写。')
}
