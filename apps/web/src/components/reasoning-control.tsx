import { Brain, ChevronDown, RotateCcw } from 'lucide-react'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { Button, Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from './ui.tsx'

const labels: Record<string, string> = { 'provider-default': '自动', enabled: '开启', off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' }
const descriptions: Record<string, string> = {
  'provider-default': '由模型决定思考方式', enabled: '先思考，再回答', off: '不使用额外思考', minimal: '尽量缩短思考时间', low: '更快响应，适合简单任务', medium: '兼顾响应速度与思考深度',
  high: '更深入地规划和推敲', xhigh: '适合复杂任务，耗时更长', max: '使用模型支持的最高思考强度',
}
export function reasoningLabel(level: string) { return level === 'off' ? uiT('关闭', { context: 'reasoning' }) : uiT(labels[level] ?? level) }

/** Show effective choices once; restoring an inherited value is an action, not another level. */
export function ReasoningControl({ levels, value, defaultLevel, resetLabel = uiT('恢复默认'), onChange, label = uiT('思考强度'), disabled = false, showLabel = false }: {
  levels: string[]; value?: string; defaultLevel: string; resetLabel?: string; onChange: (value?: string) => void; label?: string; disabled?: boolean; showLabel?: boolean
}) {
  useUiLanguage()
  const effective = value ?? defaultLevel, unavailable = !levels.includes(effective)
  const title = unavailable ? uiT('当前档位不可用') : reasoningLabel(effective)
  const display = showLabel ? uiT('思考：%{level}', { level: title }) : title
  const content = showLabel ? <><span className="reasoning-full-label">{display}</span><Brain size={14} className="reasoning-compact-icon" aria-hidden="true" /><span className="reasoning-compact-label">{unavailable ? uiT('重新选择') : title}</span></> : <span>{title}</span>
  const canReset = value !== undefined && levels.includes(defaultLevel)
  if (levels.length === 1 && !unavailable && !canReset) return <span className="reasoning-value"
    aria-label={uiT('%{label}：%{level}', { label, level: title })} title={uiT('由模型决定，无需设置。')}>{content}</span>
  return <Menu label={label} className="reasoning-menu" trigger={<Button tone="quiet" className="reasoning-trigger" disabled={disabled}
    aria-label={uiT('%{label}：%{level}', { label, level: title })} title={`${label} · ${title}`}>
    {content}<ChevronDown size={12} />
  </Button>}>
    <MenuLabel>{label}</MenuLabel>
    <MenuRadioGroup value={effective} onValueChange={next => onChange(next)}>
      {unavailable && <MenuRadioItem value={effective} disabled>{uiT('已不可用：%{level}', { level: reasoningLabel(effective) })}</MenuRadioItem>}
      {levels.map(level => <MenuRadioItem value={level} key={level}><span>{reasoningLabel(level)}<small className="menu-description">{uiT(descriptions[level] ?? level)}</small></span></MenuRadioItem>)}
    </MenuRadioGroup>
    {canReset && <><MenuSeparator /><MenuItem onSelect={() => onChange(undefined)}><RotateCcw size={14} /><span>{resetLabel}<small className="menu-description">{uiT('当前默认：%{level}', { level: reasoningLabel(defaultLevel) })}</small></span></MenuItem></>}
  </Menu>
}
