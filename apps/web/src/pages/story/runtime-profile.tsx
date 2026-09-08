import { SettingsGroup } from '../../components/settings-layout.tsx'
import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import type { StoryProfile } from '../../../../../packages/rp-core/src/types.ts'
import { ModelPicker } from '../../components/selectors.tsx'
import { Field, Input, Select } from '../../components/ui.tsx'

export function RuntimeProfile({ value, onChange }: { value: StoryProfile['runtime']; onChange: (runtime: StoryProfile['runtime']) => void }) {
  useUiLanguage()
  const patch = (next: Partial<StoryProfile['runtime']>) => onChange({ ...value, ...next })
  return <>
    <SettingsGroup><Field layout="row" label={uiT("创作模式")} help={uiT("Chat 采用 Writer 原文；Agent 可以使用工具、编排子代理和修改初稿。")}><Select value={value.executionMode} onChange={event => patch({ executionMode: event.target.value as 'chat' | 'agent' })}><option value="chat">Chat</option><option value="agent">Agent</option></Select></Field></SettingsGroup>
    <SettingsGroup title={uiT("本会话主模型")}>
    <ModelPicker value={value.provider && value.model ? { provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort } : null}
      inheritedReasoning={{ value: value.reasoningEffort, label: uiT('跟随默认设置'), onChange: reasoningEffort => patch({ reasoningEffort }) }} onChange={route => {
      const { provider: _provider, model: _model, reasoningEffort: _effort, ...runtime } = value
      onChange({ ...runtime, ...(route ?? {}) })
    }} />
    </SettingsGroup>
    <SettingsGroup><Field layout="row" label={uiT("每轮主模型最多步骤")} help={uiT("留空时 Chat 为 5 步，Agent 为 20 步。")}><Input type="number" min={1} max={100} value={value.maxSteps ?? ''} onChange={event => patch({ maxSteps: event.target.value === '' ? undefined : Number(event.target.value) })} /></Field></SettingsGroup>
  </>
}
