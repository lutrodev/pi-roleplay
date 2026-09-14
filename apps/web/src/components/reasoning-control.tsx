import { ChevronDown } from 'lucide-react'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { Button, Menu, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from './ui.tsx'

const labels: Record<string, string> = { 'provider-default': '服务默认', enabled: '开启', off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' }
const descriptions: Record<string, string> = {
  'provider-default': '不指定思考参数，由服务决定', enabled: '开启思考；此模型仅支持开关', off: '向服务明确请求关闭思考', minimal: '尽量缩短思考时间', low: '更快响应，适合简单任务', medium: '兼顾响应速度与思考深度',
  high: '更深入地规划和推敲', xhigh: '适合复杂任务，耗时更长', max: '使用模型支持的最高思考强度',
}
export function reasoningLabel(level: string) { return level === 'off' ? uiT('关闭', { context: 'reasoning' }) : uiT(labels[level] ?? level) }

/** The same keyboard-accessible control is used by the composer, defaults and each child route. */
export function ReasoningControl({ levels, value, defaultLevel, defaultLabel = uiT('模型默认'), onChange, label = uiT('思考强度'), disabled = false, control }: {
  levels: string[]; value?: string; defaultLevel: string; defaultLabel?: string; onChange: (value?: string) => void; label?: string; disabled?: boolean
  control?: import('../../../../packages/protocol/src/reasoning.ts').ReasoningControlConfig
}) {
  useUiLanguage()
  const effective = value ?? defaultLevel, unavailable = !levels.includes(effective)
  const title = unavailable ? uiT('当前档位不可用') : reasoningLabel(effective)
  return <Menu label={label} className="reasoning-menu" trigger={<Button tone="quiet" className="reasoning-trigger" disabled={disabled}
    aria-label={uiT('%{label}：%{level}', { label, level: title })} title={`${label} · ${title}${value === undefined ? ` · ${defaultLabel}` : ''}`}>
    <span>{value === undefined && defaultLabel !== uiT('模型默认') ? uiT('继承 · %{value}', { value: title }) : title}</span><ChevronDown size={12} />
  </Button>}>
    <MenuLabel>{label}</MenuLabel>
    <MenuRadioGroup value={value ?? 'default'} onValueChange={next => onChange(next === 'default' ? undefined : next)}>
      <MenuRadioItem value="default"><span>{defaultLabel}<small className="menu-description">{reasoningLabel(defaultLevel)}</small></span></MenuRadioItem>
      <MenuSeparator />
      {value !== undefined && unavailable && <MenuRadioItem value={value} disabled>{uiT('已不可用：%{level}', { level: reasoningLabel(value) })}</MenuRadioItem>}
      {levels.map(level => <MenuRadioItem value={level} key={level}><span>{reasoningLabel(level)}<small className="menu-description">{control?.mode === 'budget' && level in control.levels ? `${control.levels[level as keyof typeof control.levels]?.toLocaleString()} tokens` : uiT(descriptions[level] ?? level)}</small></span></MenuRadioItem>)}
      {levels.length === 1 && <MenuLabel>{uiT('尚无可用的思考控制，可在模型设置中配置。')}</MenuLabel>}
    </MenuRadioGroup>
  </Menu>
}
