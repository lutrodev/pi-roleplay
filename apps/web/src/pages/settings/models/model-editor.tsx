import { StatusNotice } from '../../../components/status-notice.tsx'
import { useEffect, useRef, useState } from 'react'
import { CancelButton, EditorForm, useDialogFormState } from '../../../components/form-guard.tsx'
import { SettingToggle } from '../../../components/settings-controls.tsx'
import { SettingsGroup } from '../../../components/settings-layout.tsx'
import { Button, ErrorNotice, Field, Input, Select, Textarea } from '../../../components/ui.tsx'
import { useAction } from '../../../lib/api.ts'
import { uiT } from '../../../lib/i18n.ts'
import { fields, freshModel, saveModels, type ModelFields, type Provider } from './catalog.ts'
import { ModelReasoning } from './reasoning.tsx'

export function ProtocolSelect({ value, onChange }: { value: ModelFields['api']; onChange: (value: ModelFields['api']) => void }) {
  return <Select value={value ?? ''} onChange={event => onChange(event.target.value as ModelFields['api'] || undefined)}><option value="">{uiT('Pi 内置提供方默认协议')}</option><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></Select>
}
export function ModelEditor({ provider, modelId, revision, done }: { provider: Provider; modelId?: string; revision: number; done: () => void }) {
  const [original] = useState(() => provider.models.find(model => model.model === modelId))
  const [model, setModel] = useState(() => original ? fields(original) : freshModel(provider.connection))
  const [baseline] = useState(() => JSON.stringify(model)), action = useAction()
  const [override, setOverride] = useState(model.api !== provider.connection.api || model.baseUrl !== provider.connection.baseUrl)
  const patch = (next: Partial<ModelFields>) => setModel(current => ({ ...current, ...next }))
  return <EditorForm className="stack model-editor" dirty={JSON.stringify(model) !== baseline} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => {
    if (provider.models.some(item => item.model !== modelId && item.model === model.model.trim())) throw new Error(uiT('这个连接中已有相同的模型 ID。'))
    const next = { ...model, model: model.model.trim(), label: model.label?.trim() }
    await saveModels(provider, revision, original ? provider.models.map(item => item.model === modelId ? next : fields(item)) : [...provider.models.map(fields), next]); done()
  }) }}>
    <div className="connection-caption">{uiT('服务连接')}<strong>{provider.label}</strong></div>
    <Field label={uiT('模型 ID')} help={original ? uiT('模型 ID 是现有会话的引用标识。要使用另一个 ID，请添加新模型。') : uiT('与服务返回的模型 ID 完全一致。')}><Input autoFocus={!original} required disabled={!!original} maxLength={200} value={model.model} onChange={event => patch({ model: event.target.value })} placeholder="model-id" /></Field>
    <Field label={uiT('显示名称')} help={uiT('留空使用模型 ID。')}><Input autoFocus={!!original} maxLength={200} value={model.label ?? ''} onChange={event => patch({ label: event.target.value })} /></Field>
    <SettingsGroup><SettingToggle label={uiT('支持图片输入')} checked={model.input?.includes('image') ?? false} onChange={event => patch({ input: event.target.checked ? ['text', 'image'] : ['text'] })} /></SettingsGroup>
    <ModelReasoning provider={provider.id} model={model} onChange={reasoning => patch({ reasoning })} />
    <details className="provider-advanced"><summary>{uiT('连接覆盖')}<small>{override ? uiT('这个模型使用独立的协议或地址') : uiT('使用服务连接的协议、地址和密钥')}</small></summary><div className="stack"><SettingToggle label={uiT('为这个模型单独设置协议和地址')} checked={override} onChange={event => { setOverride(event.target.checked); if (!event.target.checked) patch(provider.connection) }} />{override && <><Field label={uiT('API 协议')}><ProtocolSelect value={model.api} onChange={api => patch({ api })} /></Field><Field label={uiT('API 基础地址')}><Input type="url" required={!!model.api} value={model.baseUrl ?? ''} onChange={event => patch({ baseUrl: event.target.value || undefined })} /></Field></>}</div></details>
    <ModelParameters model={model} onChange={setModel} />
    <ErrorNotice error={action.error} /><div className="form-actions sticky-actions"><CancelButton onCancel={done} /><Button tone="primary" type="submit" disabled={action.busy || !!original && JSON.stringify(model) === baseline}>{action.busy ? uiT('正在保存…') : uiT('保存模型')}</Button></div>
  </EditorForm>
}
function ModelParameters({ model, onChange }: { model: ModelFields; onChange: (model: ModelFields) => void }) {
  const [compat, setCompat] = useState(() => JSON.stringify(model.compat ?? {}, null, 2)), [compatError, setCompatError] = useState('')
  useDialogFormState(!!compatError)
  const accepted = useRef(JSON.stringify(model.compat ?? {})), textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const next = JSON.stringify(model.compat ?? {}); if (next !== accepted.current) { accepted.current = next; setCompat(JSON.stringify(model.compat ?? {}, null, 2)); setCompatError(''); textarea.current?.setCustomValidity('') } }, [model.compat])
  const patch = (next: Partial<ModelFields>) => onChange({ ...model, ...next })
  return <details className="provider-advanced"><summary>{uiT('高级参数')}<small>{uiT('上下文、输出长度、温度与协议兼容')}</small></summary><div className="stack"><p className="muted">{uiT('请按服务提供的模型规格填写；获取模型列表不会验证这些参数。')}</p><SettingsGroup>{([['contextWindow', '上下文窗口', 1024], ['maxTokens', '模型最大输出', 1], ['outputTokens', '本应用输出上限（可选）', 1]] as const).map(([field, label, min]) => <Field layout="row" key={field} label={uiT(label)}><Input type="number" min={min} step={1} required={field !== 'outputTokens' && Boolean(model.api)} value={model[field] ?? ''} onChange={event => patch({ [field]: event.target.value ? Number(event.target.value) : undefined })} /></Field>)}<Field layout="row" label={uiT('Temperature（可选）')}><Input type="number" min={0} max={2} step={0.05} value={model.temperature ?? ''} onChange={event => patch({ temperature: event.target.value ? Number(event.target.value) : undefined })} /></Field></SettingsGroup>
    <Field label={uiT('兼容参数 JSON')} help={uiT('用于提供商的协议差异；普通模型可留 {}。')}><Textarea ref={textarea} className="code-input" value={compat} onChange={event => { setCompat(event.target.value); try { const parsed: unknown = JSON.parse(event.target.value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); accepted.current = JSON.stringify(parsed); patch({ compat: parsed }); setCompatError(''); event.target.setCustomValidity('') } catch { setCompatError(uiT('请输入 JSON 对象后再保存。')); event.target.setCustomValidity(uiT('请输入 JSON 对象。')) } }} /></Field>{compatError && <StatusNotice compact tone="error" title={uiT('兼容参数需要检查')} details={compatError} />}
  </div></details>
}
