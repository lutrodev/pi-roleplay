import type { Preferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { ReplyOptionFields } from './reply-option-fields.tsx'
import { SettingToggle } from './settings-controls.tsx'
import { SettingsGroup } from './settings-layout.tsx'

export function ReplyOptionControls({ value, onChange }: { value: Pick<Preferences, 'replyOptions' | 'replyOptionsEnabled'>; onChange: (next: Partial<Preferences>) => void }) {
  useUiLanguage()
  return <>
    <p className="muted settings-scope">{uiT('应用于所有会话，保存后从下一次正文生成起生效。')}</p>
    <SettingsGroup><SettingToggle label={uiT('自动生成回复建议')} help={uiT('主模型会在提交正文和变量时生成回复建议。关闭后不再要求生成，已有配置会保留。')} checked={value.replyOptionsEnabled} onChange={event => onChange({ replyOptionsEnabled: event.target.checked })} /></SettingsGroup>
    <ReplyOptionFields value={value.replyOptions} onChange={replyOptions => onChange({ replyOptions })} />
  </>
}
