import type { Preferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { Field, Input, Select } from './ui.tsx'
import { SettingsGroup } from './settings-layout.tsx'

export function ReplyOptionFields({ value, onChange }: { value: Preferences['replyOptions']; onChange: (value: Preferences['replyOptions']) => void }) {
  useUiLanguage()
  return <SettingsGroup title={uiT("回复选项")}><Field layout="row" label={uiT("建议数量")}><Select value={value.count} onChange={event => { const count = Number(event.target.value); onChange({ ...value, count, keywords: Array.from({ length: count }, (_, index) => value.keywords[index] ?? '') }) }}>{[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>{count}</option>)}</Select></Field><Field layout="row" label={uiT("每条建议目标字数")}><Input type="number" min={1} max={200} value={value.maxCharacters} onChange={event => onChange({ ...value, maxCharacters: Number(event.target.value) })} /></Field>{value.keywords.map((keyword, index) => <Field layout="row" key={index} label={uiT("方向 %{v0}（可选）", { v0: index + 1 })}><Input maxLength={40} value={keyword} onChange={event => onChange({ ...value, keywords: value.keywords.map((item, i) => i === index ? event.target.value : item) })} /></Field>)}</SettingsGroup>
}
