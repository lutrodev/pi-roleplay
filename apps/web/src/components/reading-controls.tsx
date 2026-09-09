import { useId, type CSSProperties } from 'react'
import { Check } from 'lucide-react'
import { DIALOGUE_COLORS, type Preferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { useMediaQuery } from '../lib/use-media-query.ts'
import { DIALOGUE_PALETTE, dialogueColorStyle } from '../lib/dialogue-colors.ts'
import { Field, Select } from './ui.tsx'
import { SettingsGroup } from './settings-layout.tsx'
import { SegmentedSetting, SettingSlider, SettingToggle } from './settings-controls.tsx'
import { Markdown } from './markdown.tsx'
import { BackgroundSettings } from './background-settings.tsx'

export function ReadingControls({ value, onChange }: {
  value: Preferences['reading'];
  onChange: (next: Partial<Preferences['reading']>) => void
}) {
  useUiLanguage()
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)'), colorId = useId()
  const highlight = value.dialogueHighlight
  const theme = value.theme === 'system' ? systemDark ? 'dark' : 'light' : value.theme
  return <>
    <SettingsGroup title={uiT('阅读偏好')} description={uiT('字体与排版应用于所有会话和资料正文，外观应用于整个界面。')}>
      <Field layout="row" label={uiT('正文字体')}><Select value={value.fontFamily} onChange={event => onChange({ fontFamily: event.target.value as Preferences['reading']['fontFamily'] })}><option value="sans">{uiT('清晰无衬线')}</option><option value="serif">{uiT('宋体阅读')}</option></Select></Field>
      <SegmentedSetting label={uiT('外观')} value={value.theme} onChange={theme => onChange({ theme })} options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' }]} />
      <SettingSlider label={uiT('字号')} value={value.fontSize} min={14} max={26} displayValue={`${value.fontSize}px`} onChange={fontSize => onChange({ fontSize })} />
      <SettingSlider label={uiT('行高')} value={value.lineHeight} min={1.4} max={2.2} step={0.05} displayValue={String(value.lineHeight)} onChange={lineHeight => onChange({ lineHeight })} />
      <SettingSlider label={uiT('正文宽度')} value={value.maxWidth} min={640} max={1100} step={10} displayValue={`${value.maxWidth}px`} onChange={maxWidth => onChange({ maxWidth })} />
    </SettingsGroup>
    <SettingsGroup title={uiT('对白高亮')}>
      <SettingToggle label={uiT('高亮引号中的文字')} help={uiT('用颜色区分会话中的对白与叙述。')} checked={highlight} onChange={event => onChange({ dialogueHighlight: event.target.checked })} />
      <fieldset className="dialogue-color-options" disabled={!highlight}>
        <legend id={colorId}>{uiT('高亮颜色')}</legend>
        <div className="dialogue-color-palette" role="radiogroup" aria-labelledby={colorId}>{DIALOGUE_COLORS.map(color => <label key={color}>
          <input type="radio" name={colorId} value={color} checked={value.dialogueColor === color} onChange={() => onChange({ dialogueColor: color })} />
          <span className="dialogue-color-option"><i aria-hidden="true" style={{ '--swatch-color': DIALOGUE_PALETTE[color][theme] } as CSSProperties} /><span>{uiT(DIALOGUE_PALETTE[color].label)}</span><Check className="dialogue-color-check" size={12} aria-hidden="true" /></span>
        </label>)}</div>
      </fieldset>
    </SettingsGroup>
    <section className="reading-preview" data-preview-theme={theme} style={dialogueColorStyle(value.dialogueColor)}><header><strong>{uiT('正文预览')}</strong><small>{uiT('保存后应用到会话')}</small></header><div className="reading-sample" style={{ '--reading-font': value.fontFamily === 'serif' ? 'var(--serif)' : 'var(--font-sans)', '--reading-size': `${value.fontSize}px`, '--reading-leading': value.lineHeight, '--reading-width': `${value.maxWidth}px` } as CSSProperties}><Markdown text={`${uiT('黄昏时，灯塔的门开了。来人站在门槛外，手里握着一封没有署名的信。')}\n\n${uiT('“你终于来了。”她说。')}`} highlight={highlight} /></div></section>
    <SettingsGroup title={uiT('消息显示')}>
      <SettingToggle label={uiT('显示消息头像')} help={uiT('在对话中显示角色与人设的头像。')} checked={value.showAvatars} onChange={event => onChange({ showAvatars: event.target.checked })} />
      <SettingToggle label={uiT('显示会话变量卡片')} help={uiT('在最新回复下方显示变量。隐藏卡片不会停止变量更新，仍可从资料中的变量页查看。')} checked={value.showStateCard} onChange={event => onChange({ showStateCard: event.target.checked })} />
    </SettingsGroup>
    <BackgroundSettings />
  </>
}
