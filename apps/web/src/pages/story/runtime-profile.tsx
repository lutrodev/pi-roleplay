import { SettingsGroup } from '../../components/settings-layout.tsx'
import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import type { StoryProfile } from '../../../../../packages/rp-core/src/types.ts'
import { useModels } from '../../lib/api.ts'
import { ModelPicker } from '../../components/selectors.tsx'
import { ErrorNotice, Field, Input, Select } from '../../components/ui.tsx'

export function RuntimeProfile({ value, onChange }: { value: StoryProfile['runtime']; onChange: (runtime: StoryProfile['runtime']) => void }) {
  useUiLanguage()
  const models = useModels(), inherited = models.data?.effectiveMain
  const inheritedModel = models.data?.models.find(model => model.provider === inherited?.provider && model.model === inherited.model)
  const patch = (next: Partial<StoryProfile['runtime']>) => onChange({ ...value, ...next })
  return <>
    <SettingsGroup><Field layout="row" label={uiT("创作模式")} help={uiT("Chat 采用 Writer 原文；Agent 可以使用工具、编排子代理和修改初稿。")}><Select value={value.executionMode} onChange={event => patch({ executionMode: event.target.value as 'chat' | 'agent' })}><option value="chat">Chat</option><option value="agent">Agent</option></Select></Field></SettingsGroup>
    <SettingsGroup title={uiT("本会话主模型")}>
    <ModelPicker value={value.provider && value.model ? { provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort } : null} onChange={route => {
      const { provider: _provider, model: _model, reasoningEffort: _effort, ...runtime } = value
      onChange({ ...runtime, ...(route ?? {}) })
    }} />
    {!value.model && inheritedModel?.thinkingLevels.some(level => level !== 'off') && <Field layout="row" label={uiT("思考强度")} help={uiT("当前继承 %{v0}。可以只覆盖本会话的思考强度。", { v0: inheritedModel.label })}><Select value={value.reasoningEffort ?? 'inherit'} onChange={event => patch({ reasoningEffort: event.target.value === 'inherit' ? undefined : event.target.value })}><option value="inherit">{uiT("使用默认设置（%{level}）", { level: inherited?.reasoningEffort ?? 'off' })}</option>{inheritedModel.thinkingLevels.map(level => <option key={level} value={level}>{level === 'off' ? uiT("关闭", { context: 'reasoning' }) : level}</option>)}</Select></Field>}
    </SettingsGroup><ErrorNotice error={models.error} />
    <SettingsGroup><Field layout="row" label={uiT("每轮主模型最多步骤")} help={uiT("留空时 Chat 为 5 步，Agent 为 20 步。")}><Input type="number" min={1} max={100} value={value.maxSteps ?? ''} onChange={event => patch({ maxSteps: event.target.value === '' ? undefined : Number(event.target.value) })} /></Field></SettingsGroup>
  </>
}
