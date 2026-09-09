import { EditorFooter } from '../../../components/editor-footer.tsx'
import { StatusNotice } from '../../../components/status-notice.tsx'
import { useEffect, useRef, useState } from 'react'
import { CancelButton, EditorForm, useDialogFormState } from '../../../components/form-guard.tsx'
import { SettingToggle } from '../../../components/settings-controls.tsx'
import { ConnectionLogo } from './service-logo.tsx'
import { Button, Field, Input, Select, Textarea } from '../../../components/ui.tsx'
import { api, useAction } from '../../../lib/api.ts'
import { uiT } from '../../../lib/i18n.ts'
import { fields, freshModel, saveModels, type Discovery, type ModelFields, type Provider } from './catalog.ts'
import { ModelCapabilityFields, useModelMetadata } from './model-capability-fields.tsx'

export function ProtocolSelect({ value, onChange }: { value: ModelFields['api']; onChange: (value: ModelFields['api']) => void }) {
  return <Select value={value ?? ''} onChange={event => onChange(event.target.value as ModelFields['api'] || undefined)}><option value="">{uiT('Pi 内置提供方默认协议')}</option><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></Select>
}
export function ModelEditor({ provider, modelId, revision, done }: { provider: Provider; modelId?: string; revision: number; done: () => void }) {
  const [original] = useState(() => provider.models.find(model => model.model === modelId))
  const [model, setModel] = useState(() => original ? fields(original) : freshModel(provider.connection))
  const [baseline] = useState(() => JSON.stringify(model)), action = useAction(), discovery = useAction()
  const [discoveryId, setDiscoveryId] = useState<string>(), metadata = useModelMetadata(provider.id, model, discoveryId)
  const dirty = JSON.stringify(model) !== baseline || !!discoveryId
  async function refreshMetadata() { await discovery.run(async () => { const result = await api<Discovery>('/settings/providers/discover', 'POST', { provider: provider.id, connection: { api: model.api, baseUrl: model.baseUrl } }); setDiscoveryId(result.discoveryId) }) }
  const [override, setOverride] = useState(model.api !== provider.connection.api || model.baseUrl !== provider.connection.baseUrl)
  const patch = (next: Partial<ModelFields>) => setModel(current => ({ ...current, ...next }))
  return <EditorForm className="stack model-editor" dirty={dirty} busy={action.busy || discovery.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => {
    if (provider.models.some(item => item.model !== modelId && item.model === model.model.trim())) throw new Error(uiT('这个连接中已有相同的模型 ID。'))
    const next = { ...model, model: model.model.trim(), label: model.label?.trim() }
    await saveModels(provider, revision, original ? provider.models.map(item => item.model === modelId ? next : fields(item)) : [...provider.models.map(fields), next], discoveryId); done()
  }) }}>
    <div className="model-identity"><ConnectionLogo connection={provider.connection} label={provider.label} /><div><strong>{provider.label}</strong>{original && <code title={model.model}>{model.model}</code>}</div></div>
    {!original && <Field label={uiT('模型 ID')} help={uiT('与服务返回的模型 ID 完全一致。')}><Input autoFocus required maxLength={200} value={model.model} onChange={event => { patch({ model: event.target.value }); setDiscoveryId(undefined) }} placeholder="model-id" /></Field>}
    <Field layout="row" label={uiT('显示名称')} help={uiT('留空自动识别名称。')}><Input autoFocus={!!original} maxLength={200} value={model.label ?? ''} placeholder={metadata.data?.label ?? model.model} onChange={event => patch({ label: event.target.value || undefined })} /></Field>
    <ModelCapabilityFields model={model} patch={patch} auto={metadata.data} loading={metadata.isFetching} refreshing={discovery.busy}
      onRefresh={provider.credentialConfigured ? () => void refreshMetadata() : undefined} error={discovery.error ?? metadata.error} retry={() => { if (discovery.error) void refreshMetadata(); else void metadata.refetch() }} />
    <details className="provider-advanced"><summary>{uiT('连接覆盖')}<small>{override ? uiT('这个模型使用独立的协议或地址') : uiT('使用服务连接的协议、地址和密钥')}</small></summary><div className="stack"><SettingToggle label={uiT('为这个模型单独设置协议和地址')} checked={override} onChange={event => { setOverride(event.target.checked); if (!event.target.checked) { patch(provider.connection); setDiscoveryId(undefined) } }} />{override && <><Field label={uiT('API 协议')}><ProtocolSelect value={model.api} onChange={api => { patch({ api }); setDiscoveryId(undefined) }} /></Field><Field label={uiT('API 基础地址')}><Input type="url" required={!!model.api} value={model.baseUrl ?? ''} onChange={event => { patch({ baseUrl: event.target.value || undefined }); setDiscoveryId(undefined) }} /></Field></>}</div></details>
    <ModelParameters model={model} onChange={setModel} />
    <EditorFooter error={action.error}><CancelButton onCancel={done} /><Button tone="primary" type="submit" disabled={action.busy || discovery.busy || !!original && !dirty}>{action.busy ? uiT('正在保存…') : uiT('保存模型')}</Button></EditorFooter>
  </EditorForm>
}
function ModelParameters({ model, onChange }: { model: ModelFields; onChange: (model: ModelFields) => void }) {
  const [compat, setCompat] = useState(() => JSON.stringify(model.compat ?? {}, null, 2)), [compatError, setCompatError] = useState('')
  useDialogFormState(!!compatError)
  const accepted = useRef(JSON.stringify(model.compat ?? {})), textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const next = JSON.stringify(model.compat ?? {}); if (next !== accepted.current) { accepted.current = next; setCompat(JSON.stringify(model.compat ?? {}, null, 2)); setCompatError(''); textarea.current?.setCustomValidity('') } }, [model.compat])
  const patch = (next: Partial<ModelFields>) => onChange({ ...model, ...next })
  return <details className="provider-advanced"><summary>{uiT('生成参数')}<small>{uiT('输出预算、温度与协议兼容')}</small></summary><div className="stack"><div className="model-generation-grid"><Field label={uiT('本应用输出上限')} help={uiT('留空自动使用不超过 8K 的输出预算。')}><Input type="number" min={1} step={1} value={model.outputTokens ?? ''} placeholder={uiT('自动')} onChange={event => patch({ outputTokens: event.target.value ? Number(event.target.value) : undefined })} /></Field><Field label="Temperature" help={uiT('留空使用服务默认值。')}><Input type="number" min={0} max={2} step={0.05} value={model.temperature ?? ''} placeholder={uiT('服务默认')} onChange={event => patch({ temperature: event.target.value ? Number(event.target.value) : undefined })} /></Field></div>
    <Field label={uiT('兼容参数 JSON')} help={uiT('用于提供商的协议差异；普通模型可留 {}。')}><Textarea ref={textarea} className="code-input" value={compat} onChange={event => { setCompat(event.target.value); try { const parsed: unknown = JSON.parse(event.target.value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); accepted.current = JSON.stringify(parsed); patch({ compat: parsed }); setCompatError(''); event.target.setCustomValidity('') } catch { setCompatError(uiT('请输入 JSON 对象后再保存。')); event.target.setCustomValidity(uiT('请输入 JSON 对象。')) } }} /></Field>{compatError && <StatusNotice compact tone="error" title={uiT('兼容参数需要检查')} details={compatError} />}
  </div></details>
}
