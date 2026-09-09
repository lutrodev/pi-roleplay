import { SettingRow } from './settings-layout.tsx'
import { useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import type { ModelRoute } from '../../../../packages/rp-core/src/types.ts'
import { useModels } from '../lib/api.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { Button, Empty, ErrorNotice, Input, Loading, Modal } from './ui.tsx'
import { ReasoningControl } from './reasoning-control.tsx'

export function ModelPicker({ value, onChange, inheritLabel = uiT('跟随系统默认模型'), allowInherit = true, inheritDetail, defaultChoice, label = uiT('模型'), layout = 'row', inheritedReasoning }: {
  inheritDetail?: string; value: ModelRoute | null; onChange: (route: ModelRoute | null) => void; inheritLabel?: string; allowInherit?: boolean; label?: string
  layout?: 'row' | 'compact'
  defaultChoice?: { selected: boolean; label: string; detail: string; onSelect: () => void }
  inheritedReasoning?: { route?: ModelRoute | null; value?: string; label?: string; onChange: (effort?: string) => void }
}) {
  useUiLanguage()
  const query = useModels(), models = query.data?.models ?? [], selected = models.find(model => model.provider === value?.provider && model.model === value.model)
  const [open, setOpen] = useState(false), [search, setSearch] = useState('')
  const filtered = models.filter(model => [model.label, model.model, model.provider].join(' ').toLowerCase().includes(search.toLowerCase()))
  const effective = models.find(model => model.provider === query.data?.effectiveMain?.provider && model.model === query.data.effectiveMain.model)
  const inheritedRoute = inheritedReasoning?.route === undefined ? query.data?.effectiveMain : inheritedReasoning.route
  const inheritedModel = models.find(model => model.provider === inheritedRoute?.provider && model.model === inheritedRoute.model)
  const reasoningModel = !defaultChoice?.selected && selected ? selected : inheritedReasoning ? inheritedModel : undefined
  const fixedReasoning = !defaultChoice?.selected && Boolean(selected)
  const choose = (route: ModelRoute | null) => { onChange(route); setOpen(false); setSearch('') }
  const title = defaultChoice?.selected ? defaultChoice.label : selected?.label ?? value?.model ?? (allowInherit ? inheritLabel : uiT('请选择模型'))
  const trigger = <Button className="model-picker-trigger" aria-label={uiT('选择%{label}：%{name}', { label, name: title })} aria-haspopup="dialog" onClick={() => setOpen(true)}><span><strong>{title}</strong><small>{defaultChoice?.selected ? defaultChoice.detail : value ? selected ? selected.configured ? selected.provider : uiT('缺少密钥') : uiT('模型配置已不可用') : inheritDetail ?? effective?.label ?? uiT('尚未选择模型')}</small></span><ChevronDown size={16} /></Button>
  return <div className="model-picker">{layout === 'compact' ? trigger : <SettingRow kind="field" label={label}>{trigger}</SettingRow>}
    {reasoningModel?.thinkingLevels.some(level => level !== 'off') && <SettingRow kind="field" label={uiT('思考强度')}><ReasoningControl label={uiT('%{label}思考强度', { label })}
      levels={reasoningModel.thinkingLevels} value={fixedReasoning ? value?.reasoningEffort : inheritedReasoning?.value}
      defaultLevel={(!fixedReasoning ? inheritedRoute?.reasoningEffort : undefined) ?? reasoningModel.defaultThinkingLevel}
      defaultLabel={fixedReasoning ? uiT('模型默认') : inheritedReasoning?.label ?? uiT('跟随主模型')}
      onChange={effort => fixedReasoning ? onChange({ ...value!, reasoningEffort: effort }) : inheritedReasoning?.onChange(effort)} /></SettingRow>}
    {!open && <ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />}
    <Modal size="form" className="settings-modal model-picker-dialog" open={open} onOpenChange={setOpen} title={uiT('选择模型')}><div className="stack"><div className="search-field"><Search size={16} /><Input autoFocus aria-label={uiT('搜索可用模型')} placeholder={uiT('搜索模型名称、ID 或连接')} value={search} onChange={event => setSearch(event.target.value)} /></div><ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />{query.isPending && <Loading />}
      <div className="model-options">{defaultChoice && !search && <button type="button" className="model-option" aria-pressed={defaultChoice.selected} onClick={() => { defaultChoice.onSelect(); setOpen(false); setSearch('') }}><span><strong>{defaultChoice.label}</strong><small>{defaultChoice.detail}</small></span>{defaultChoice.selected && <Check size={16} />}</button>}{allowInherit && !search && <button type="button" className="model-option" aria-pressed={!value && !defaultChoice?.selected} onClick={() => choose(null)}><span><strong>{inheritLabel}</strong><small>{inheritDetail ?? effective?.label ?? uiT('尚未选择模型')}</small></span>{!value && !defaultChoice?.selected && <Check size={16} />}</button>}{filtered.map(model => <button type="button" className="model-option" key={JSON.stringify([model.provider, model.model])} disabled={!model.configured} aria-pressed={!defaultChoice?.selected && model.provider === value?.provider && model.model === value.model} onClick={() => choose({ provider: model.provider, model: model.model })}><span><strong>{model.label}</strong><small>{model.provider} · {model.configured ? model.input.includes('image') ? uiT('文字与图片') : uiT('文字') : uiT('缺少密钥')}</small>{model.label !== model.model && <small>{model.model}</small>}</span>{!defaultChoice?.selected && model.provider === value?.provider && model.model === value.model && <Check size={16} />}</button>)}</div>
      {!query.error && !query.isPending && !filtered.length && <Empty title={search ? uiT('没有找到模型') : uiT('尚未配置模型')}>{uiT('可以在设置的“模型”中添加服务连接。')}</Empty>}
    </div></Modal>
  </div>
}
