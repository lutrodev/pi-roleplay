import type { CSSProperties } from 'react'
import { DIALOGUE_COLORS, ITALIC_COLORS, type Preferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { useMediaQuery } from '../lib/use-media-query.ts'
import { DIALOGUE_PALETTE, ITALIC_PALETTE, dialogueColorStyle, italicColorStyle } from '../lib/reading-colors.ts'
import { Field, Select } from './ui.tsx'
import { SettingsGroup } from './settings-layout.tsx'
import { SegmentedSetting, SettingSlider, SettingToggle } from './settings-controls.tsx'
import { Markdown } from './markdown.tsx'
import { BackgroundSettings } from './background-settings.tsx'
import { ReadingHighlightControls } from './reading-highlight-controls.tsx'

export function ReadingControls({ value, onChange }: {
  value: Preferences['reading'];
  onChange: (next: Partial<Preferences['reading']>) => void
}) {
  useUiLanguage()
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
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
    <ReadingHighlightControls title={uiT('对白高亮')} label={uiT('高亮引号中的文字')} help={uiT('用颜色区分会话中的对白与叙述。')} colorLabel={uiT('对白颜色')}
      enabled={highlight} color={value.dialogueColor} colors={DIALOGUE_COLORS} palette={DIALOGUE_PALETTE} theme={theme}
      onToggle={dialogueHighlight => onChange({ dialogueHighlight })} onColor={dialogueColor => onChange({ dialogueColor })} />
    <ReadingHighlightControls title={uiT('斜体高亮')} label={uiT('为斜体文字着色')} help={uiT('关闭后保留斜体样式；斜体中的对白优先使用这里的颜色。')} colorLabel={uiT('斜体颜色')}
      enabled={value.italicHighlight} color={value.italicColor} colors={ITALIC_COLORS} palette={ITALIC_PALETTE} theme={theme}
      onToggle={italicHighlight => onChange({ italicHighlight })} onColor={italicColor => onChange({ italicColor })} />
    <section className="reading-preview" data-preview-theme={theme} style={{ ...dialogueColorStyle(value.dialogueColor), ...italicColorStyle(value.italicColor, value.italicHighlight) }}><header><strong>{uiT('正文预览')}</strong><small>{uiT('保存后应用到正文')}</small></header><div className="reading-sample" style={{ '--reading-font': value.fontFamily === 'serif' ? 'var(--serif)' : 'var(--font-sans)', '--reading-size': `${value.fontSize}px`, '--reading-leading': value.lineHeight, '--reading-width': `${value.maxWidth}px` } as CSSProperties}><Markdown text={`${uiT('黄昏时，灯塔的门开了。来人站在门槛外，手里握着一封没有署名的信。')}\n\n${uiT('“你终于来了。”她说。')}\n\n*${uiT('她在心里松了一口气。')}*`} highlight={highlight} /></div></section>
    <SettingsGroup title={uiT('消息显示')}>
      <SettingToggle label={uiT('显示消息头像')} help={uiT('在对话中显示角色与人设的头像。')} checked={value.showAvatars} onChange={event => onChange({ showAvatars: event.target.checked })} />
      <SettingToggle label={uiT('显示会话变量卡片')} help={uiT('在最新回复下方显示变量。隐藏卡片不会停止变量更新，仍可从资料中的变量页查看。')} checked={value.showStateCard} onChange={event => onChange({ showStateCard: event.target.checked })} />
    </SettingsGroup>
    <BackgroundSettings />
  </>
}
