import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ModelRoute } from '../../../../packages/rp-core/src/types.ts'
import { useModels } from '../lib/api.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { Button, ErrorNotice } from './ui.tsx'
import { ModelSelect } from './model-select.tsx'
import { ReasoningControl } from './reasoning-control.tsx'

export function ModelPicker({ value, onChange, inheritLabel = uiT('跟随系统默认模型'), allowInherit = true, inheritDetail, defaultChoice, label = uiT('模型'), layout = 'row', inheritedReasoning }: {
  inheritDetail?: string; value: ModelRoute | null; onChange: (route: ModelRoute | null) => void; inheritLabel?: string; allowInherit?: boolean; label?: string
  layout?: 'row' | 'compact'
  defaultChoice?: { selected: boolean; label: string; detail: string; onSelect: () => void }
  inheritedReasoning?: { route?: ModelRoute | null; value?: string; label?: string; onChange: (effort?: string) => void }
}) {
  useUiLanguage()
  const query = useModels(), models = query.data?.models ?? [], selected = models.find(model => model.provider === value?.provider && model.model === value.model)
  const [open, setOpen] = useState(false)
  const effective = models.find(model => model.provider === query.data?.effectiveMain?.provider && model.model === query.data.effectiveMain.model)
  const inheritedRoute = inheritedReasoning?.route === undefined ? query.data?.effectiveMain : inheritedReasoning.route
  const inheritedModel = models.find(model => model.provider === inheritedRoute?.provider && model.model === inheritedRoute.model)
  const reasoningModel = !defaultChoice?.selected && selected ? selected : inheritedReasoning ? inheritedModel : undefined
  const fixedReasoning = !defaultChoice?.selected && Boolean(selected)
  const title = defaultChoice?.selected ? defaultChoice.label : selected?.label ?? value?.model ?? (allowInherit ? inheritLabel : uiT('请选择模型'))
  const trigger = <Button className="model-picker-trigger" aria-label={uiT('选择%{label}：%{name}', { label, name: title })} aria-haspopup="dialog" onClick={() => setOpen(true)}><span><strong>{title}</strong><small>{defaultChoice?.selected ? defaultChoice.detail : value ? selected ? selected.configured ? selected.providerLabel : uiT('缺少密钥') : uiT('模型配置已不可用') : inheritDetail ?? effective?.label ?? uiT('尚未选择模型')}</small></span><ChevronDown size={16} /></Button>
  return <div className={'model-picker model-picker-' + layout}>{layout === 'row' && <div className="model-picker-label">{label}</div>}<div className="model-picker-controls"><ModelSelect trigger={trigger} open={open} onOpenChange={setOpen} value={value} onChange={onChange}
      inheritLabel={allowInherit ? inheritLabel : undefined} inheritDetail={inheritDetail ?? effective?.label ?? uiT('尚未选择模型')} defaultChoice={defaultChoice} />
    {reasoningModel?.thinkingLevels.some(level => level !== 'off') && <div className="model-thinking-row"><span>{uiT('思考强度')}</span><ReasoningControl label={uiT('%{label}思考强度', { label })}
      levels={reasoningModel.thinkingLevels} value={fixedReasoning ? value?.reasoningEffort : inheritedReasoning?.value}
      defaultLevel={(!fixedReasoning ? inheritedRoute?.reasoningEffort : undefined) ?? reasoningModel.defaultThinkingLevel}
      defaultLabel={fixedReasoning ? uiT('模型默认') : inheritedReasoning?.label ?? uiT('跟随主模型')}
      onChange={effort => fixedReasoning ? onChange({ ...value!, reasoningEffort: effort }) : inheritedReasoning?.onChange(effort)} /></div>}</div>
    {!open && <ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />}

  </div>
}
