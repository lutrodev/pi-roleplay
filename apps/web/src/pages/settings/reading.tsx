import { SettingsGroup } from '../../components/settings-layout.tsx'
import type { Preferences } from '../../../../../packages/rp-core/src/settings/preferences.ts'
import { Field, Select } from '../../components/ui.tsx'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { ReadingControls } from '../../components/reading-controls.tsx'

export function ReadingSettings({ value, onChange }: { value: Preferences; onChange: (next: Partial<Preferences>) => void }) {
  useUiLanguage()
  return <>
    <SettingsGroup title={uiT('对话偏好')}>
      <Field layout="row" label={uiT('语言')} help={uiT('只改变界面语言，角色卡、故事正文和模型写作规则保持原文。')}>
        <Select value={value.language} onChange={event => onChange({ language: event.target.value as Preferences['language'] })}><option value="zh">{uiT('简体中文')}</option><option value="en">English</option></Select>
      </Field>
      <Field layout="row" label={uiT('已完成轮次的过程内容')} help={uiT('默认从回复下方打开完整轨迹，也可在正文后显示过程概览。')}>
        <Select value={value.transcriptView} onChange={event => onChange({ transcriptView: event.target.value as Preferences['transcriptView'] })}><option value="compact">{uiT('Compact · 折叠过程')}</option><option value="normal">{uiT('Normal · 显示过程概览')}</option></Select>
      </Field>
      <Field layout="row" label={uiT('生成中按 Enter')} help={uiT('⌘ / Ctrl + Enter 使用另一种行为；空输入时干预全部待发消息。Shift + Enter 换行。')}>
        <Select value={value.busyEnter} onChange={event => onChange({ busyEnter: event.target.value as Preferences['busyEnter'] })}><option value="queue">{uiT('加入待发消息')}</option><option value="steer">{uiT('干预当前回复')}</option></Select>
      </Field>
    </SettingsGroup>
    <ReadingControls value={value.reading} onChange={next => onChange({ reading: { ...value.reading, ...next } })} />
  </>
}
