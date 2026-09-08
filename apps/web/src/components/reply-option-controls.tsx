import type { Preferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { ReplyOptionFields } from './reply-option-fields.tsx'
import { SettingToggle } from './settings-controls.tsx'
import { SettingsGroup } from './settings-layout.tsx'

export function ReplyOptionControls({ value, onChange }: { value: Pick<Preferences, 'replyOptions' | 'replyOptionsEnabled'>; onChange: (next: Partial<Preferences>) => void }) {
  useUiLanguage()
  return <>
    <SettingsGroup><SettingToggle label={uiT('自动生成回复建议')} help={uiT('回复建议会与正文一起保存。关闭后跳过建议生成，已有配置会保留。')} checked={value.replyOptionsEnabled} onChange={event => onChange({ replyOptionsEnabled: event.target.checked })} /></SettingsGroup>
    <ReplyOptionFields value={value.replyOptions} onChange={replyOptions => onChange({ replyOptions })} />
    <p className="muted">{uiT('保存后从下一次正文生成起使用。')}</p>
  </>
}
