import { useState } from 'react'
import { CancelButton, EditorForm } from '../../../components/form-guard.tsx'
import { SettingToggle } from '../../../components/settings-controls.tsx'
import { Button, ErrorNotice, Field, Input } from '../../../components/ui.tsx'
import { api, useAction } from '../../../lib/api.ts'
import { uiT } from '../../../lib/i18n.ts'
import { fields, refreshModels, type Provider } from './catalog.ts'
import { ProtocolSelect } from './model-editor.tsx'
import type { ModelConnection } from '../../../../../../apps/server/src/services/model-inspection.ts'

export function ConnectionFields({ connection, onChange, apiKey, setKey, stored = false, disabled = false }: { connection: ModelConnection; onChange: (value: ModelConnection) => void; apiKey: string; setKey: (value: string) => void; stored?: boolean; disabled?: boolean }) {
  return <><ConnectionKeyField apiKey={apiKey} setKey={setKey} stored={stored} disabled={disabled} /><ConnectionAddressFields connection={connection} onChange={onChange} /></>
}
export function ConnectionKeyField({ apiKey, setKey, stored = false, disabled = false, autoFocus = false }: { apiKey: string; setKey: (value: string) => void; stored?: boolean; disabled?: boolean; autoFocus?: boolean }) {
  return <Field label={uiT('API 密钥')} help={stored ? uiT('留空保留当前密钥。') : uiT('密钥加密保存在当前服务中，不会提供给模型工具。')}><Input type="password" autoFocus={autoFocus} autoComplete="new-password" maxLength={8192} value={apiKey} disabled={disabled} onChange={event => setKey(event.target.value)} placeholder={stored ? uiT('已配置 · 输入以替换') : uiT('粘贴 API 密钥')} /></Field>
}
export function ConnectionAddressFields({ connection, onChange }: { connection: ModelConnection; onChange: (value: ModelConnection) => void }) {
  return <><Field label={uiT('API 基础地址')} help={uiT('填写 API 前缀，不包含 /chat/completions、密钥或查询参数。')}><Input type="url" required value={connection.baseUrl} onChange={event => onChange({ ...connection, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></Field>
    <Field label={uiT('API 协议')}><ProtocolSelect value={connection.api} onChange={api => onChange({ ...connection, api })} /></Field></>
}
export function ConnectionEditor({ provider, revision, done }: { provider: Provider; revision: number; done: () => void }) {
  const [label, setLabel] = useState(provider.label), [connection, setConnection] = useState(provider.connection), [apiKey, setKey] = useState(''), [clearKey, setClearKey] = useState(false), action = useAction()
  const dirty = label !== provider.label || JSON.stringify(connection) !== JSON.stringify(provider.connection) || !!apiKey || clearKey
  const inherited = provider.models.filter(model => model.api === provider.connection.api && model.baseUrl === provider.connection.baseUrl).length
  return <EditorForm className="stack model-editor" dirty={dirty} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => {
    // Only models using the old shared value follow a connection edit. Explicit overrides survive.
    const models = provider.models.map(model => ({ ...fields(model), ...(model.api === provider.connection.api ? { api: connection.api } : {}), ...(model.baseUrl === provider.connection.baseUrl ? { baseUrl: connection.baseUrl } : {}) }))
    await api('/settings/providers', 'PUT', { expectedRevision: revision, provider: { id: provider.id, label, connection, models, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(clearKey ? { clearKey: true } : {}) } }); setKey(''); await refreshModels(); done()
  }) }}><Field label={uiT('连接名称')}><Input autoFocus required maxLength={200} value={label} onChange={event => setLabel(event.target.value)} /></Field>
    <ConnectionFields connection={connection} onChange={setConnection} apiKey={apiKey} setKey={setKey} stored={provider.credentialConfigured} disabled={clearKey} />
    <p className="muted">{uiT('%{count} 个模型使用此连接；模型中的独立覆盖会保留。', { count: inherited })}</p>
    <details className="provider-advanced"><summary>{uiT('密钥与连接标识')}</summary><div className="stack"><Field label={uiT('连接标识')}><Input readOnly value={provider.id} /></Field><SettingToggle label={uiT('移除当前密钥')} help={uiT('此连接的模型将无法生成回复，重新填写密钥后即可恢复。')} checked={clearKey} onChange={event => { setClearKey(event.target.checked); if (event.target.checked) setKey('') }} /></div></details>
    <ErrorNotice error={action.error} /><div className="form-actions sticky-actions"><CancelButton onCancel={done} /><Button type="submit" tone="primary" disabled={!dirty || action.busy}>{action.busy ? uiT('正在保存…') : uiT('保存连接')}</Button></div>
  </EditorForm>
}
