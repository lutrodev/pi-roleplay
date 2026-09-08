import { StatusNotice } from '../../../components/status-notice.tsx'
import { useState } from 'react'
import { ArrowLeft, Check as CheckIcon, Search } from 'lucide-react'
import type { ModelRoute } from '../../../../../../packages/rp-core/src/types.ts'
import type { ModelCheck, ModelConnection } from '../../../../../../apps/server/src/services/model-inspection.ts'
import { CancelButton, EditorForm, useDialogFormState } from '../../../components/form-guard.tsx'
import { Button, Check, Empty, ErrorNotice, Field, Input, Loading, Select, Textarea } from '../../../components/ui.tsx'
import { api, useAction } from '../../../lib/api.ts'
import { uiT } from '../../../lib/i18n.ts'
import { fields, freshModel, refreshModels, type Catalog, type Discovery, type Provider } from './catalog.ts'
import { ServicePicker } from './service-picker.tsx'
import { ServiceConnection } from './service-connection.tsx'
import { customService, type ServicePreset } from './service-presets.ts'

export function ConnectionWizard({ revision, provider, done, onDefault }: { revision: number; provider?: Provider; done: () => void; onDefault: (route: ModelRoute | null) => Promise<void> }) {
  const [step, setStep] = useState(provider ? 2 : 0), [service, setService] = useState<ServicePreset | null>(null), [serviceSearch, setServiceSearch] = useState(''), [id] = useState(() => 'provider-' + crypto.randomUUID().slice(0, 8))
  const [label, setLabel] = useState(provider?.label ?? ''), [connection, setConnection] = useState<ModelConnection>(provider?.connection ?? { api: 'openai-completions', baseUrl: '' }), [apiKey, setKey] = useState('')
  const [available, setAvailable] = useState<Discovery['models'] | null>(null), [selected, setSelected] = useState<string[]>([]), [search, setSearch] = useState(''), [manual, setManual] = useState(''), [mode, setMode] = useState<'list' | 'manual'>('list')
  const [truncated, setTruncated] = useState(false)
  const [finished, setFinished] = useState<{ catalog: Catalog; ids: string[] } | null>(null), discover = useAction(), save = useAction()
  const existing = new Set(provider?.models.map(model => model.model) ?? []), manualIds = [...new Set(manual.split(/[\n,，]/).map(value => value.trim()).filter(Boolean))]
  const ids = (mode === 'manual' ? manualIds : selected).filter(model => !existing.has(model))
  const dirty = !finished && (!!label || !!apiKey || !!manual || selected.length > 0 || !provider && step > 0)
  function resetDiscovery() { setAvailable(null); setSelected([]); setSearch(''); setTruncated(false); discover.clear(); save.clear() }
  function selectService(next: ServicePreset) {
    if (next.id !== service?.id) {
      setService(next); setLabel(next.id === 'custom' ? '' : uiT(next.label)); setConnection({ ...next.connection })
      setKey(''); setManual(''); setMode('list'); resetDiscovery()
    }
    setStep(1)
  }
  async function fetchModels() {
    await discover.run(async () => { const result = await api<Discovery>('/settings/providers/discover', 'POST', { connection, ...(provider ? { provider: provider.id } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }); setAvailable(result.models); setTruncated(result.truncated ?? false); setSelected(current => current.filter(id => result.models.some(model => model.model === id))) })
  }
  if (finished) return <ConnectionComplete catalog={finished.catalog} providerId={provider?.id ?? id} ids={finished.ids} done={done} onDefault={onDefault} />
  return <EditorForm className="stack model-editor connection-wizard" data-step={step} dirty={dirty} busy={save.busy || discover.busy} onSubmit={event => { event.preventDefault(); if (step === 1) { setStep(2); return } if (step !== 2) return; void save.run(async () => {
    if (!ids.length) throw new Error(uiT('请至少选择或填写一个新模型。'))
    if (ids.some(model => model.length > 200) || ids.length + existing.size > 64) throw new Error(uiT('每个连接最多 64 个模型，模型 ID 最多 200 字符。'))
    const added = ids.map(model => freshModel(connection, model, available?.find(item => item.model === model)?.label ?? model))
    const result = await api<Catalog>('/settings/providers', provider ? 'PUT' : 'POST', { expectedRevision: revision, provider: { id: provider?.id ?? id, label, connection, models: [...(provider?.models.map(fields) ?? []), ...added], ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) } })
    setKey(''); await refreshModels(); setFinished({ catalog: result, ids })
  }) }}>
    {!provider && <ol className="connection-steps" aria-label={uiT('接入步骤')}>{['选择服务', '连接信息', '选择模型'].map((name, index) => <li key={name} aria-current={index === step ? 'step' : undefined} data-complete={index < step}><span>{index < step ? <CheckIcon size={12} /> : index + 1}</span>{uiT(name)}</li>)}</ol>}
    {step === 0 && <ServicePicker search={serviceSearch} onSearch={setServiceSearch} onSelect={selectService} />}
    {step === 1 && <ServiceConnection service={service ?? customService} label={label} setLabel={setLabel} connection={connection} onConnection={value => { setConnection(value); resetDiscovery() }} apiKey={apiKey} setKey={value => { setKey(value); resetDiscovery() }} />}
    {step === 2 && <><div className="connection-caption">{uiT('服务连接')}<strong>{label}</strong></div><div className="model-source-switch"><Button aria-pressed={mode === 'list'} onClick={() => setMode('list')}>{uiT('从服务获取')}</Button><Button aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>{uiT('手动填写 ID')}</Button></div>
      {mode === 'list' ? <><div className="section-heading"><p className="muted">{uiT('获取列表后，选择要在会话中使用的模型。')}</p><Button disabled={discover.busy} onClick={() => void fetchModels()}>{available ? uiT('重新获取') : uiT('获取模型列表')}</Button></div><ErrorNotice error={discover.error} />{discover.error && <Button tone="quiet" onClick={() => setMode('manual')}>{uiT('改为手动填写')}</Button>}{discover.busy && <Loading label={uiT('正在获取模型…')} />}
        {available && <>{truncated && <p className="notice">{uiT('列表达到读取上限。未找到的模型可手动填写 ID。')}</p>}<div className="search-field"><Search size={16} /><Input aria-label={uiT('搜索可添加模型')} placeholder={uiT('搜索模型名称或 ID')} value={search} onChange={event => setSearch(event.target.value)} /></div><div className="discovered-models">{available.filter(model => (model.model + model.label).toLowerCase().includes(search.toLowerCase())).map(model => <Check key={model.model} label={model.label} help={existing.has(model.model) ? uiT('已添加') : model.model} disabled={existing.has(model.model) || selected.length + existing.size >= 64 && !selected.includes(model.model)} checked={existing.has(model.model) || selected.includes(model.model)} onChange={event => setSelected(current => event.target.checked ? [...current, model.model] : current.filter(id => id !== model.model))} />)}{!available.some(model => (model.model + model.label).toLowerCase().includes(search.toLowerCase())) && <Empty title={uiT('没有找到模型')} action={<Button onClick={() => setMode('manual')}>{uiT('手动填写 ID')}</Button>} />}</div></>}
      </> : <Field label={uiT('模型 ID')} help={uiT('每行一个 ID，也可以用逗号分隔。')}><Textarea autoFocus required rows={6} value={manual} onChange={event => setManual(event.target.value)} placeholder={'model-id-1\nmodel-id-2'} /></Field>}
      <p className="muted">{uiT('新模型先使用通用参数：128K 上下文、8K 最大输出、文字输入。添加后可逐个核对和调整。')}</p>
    </>}
    <ErrorNotice error={save.error} /><div className="form-actions sticky-actions">{step > 0 && !provider ? <Button onClick={() => setStep(step - 1)}><ArrowLeft size={15} />{uiT('上一步')}</Button> : <CancelButton onCancel={done} />}{step === 2 && <span className="settings-save-status" role="status">{uiT('已选择 %{count} 个', { count: ids.length })}</span>}{step > 0 && <Button type="submit" tone="primary" disabled={save.busy || discover.busy || step === 2 && !ids.length}>{save.busy ? uiT('正在保存…') : step === 1 ? uiT('下一步') : uiT('添加模型')}</Button>}</div>
  </EditorForm>
}
function ConnectionComplete({ catalog, providerId, ids, done, onDefault }: { catalog: Catalog; providerId: string; ids: string[]; done: () => void; onDefault: (route: ModelRoute | null) => Promise<void> }) {
  const provider = catalog.providers.find(item => item.id === providerId)!, [selected, setSelected] = useState(ids[0]!), [result, setResult] = useState<ModelCheck | null>(null), [defaultSaved, setDefaultSaved] = useState(false), action = useAction()
  useDialogFormState(false, action.busy)
  return <div className="stack connection-complete"><div className="completion-mark"><CheckIcon size={24} /></div><h3>{uiT('已添加 %{count} 个模型', { count: ids.length })}</h3><p className="muted">{uiT('可以现在测试并设为默认，也可以稍后在模型列表中操作。')}</p><Field label={uiT('模型')}><Select value={selected} onChange={event => { setSelected(event.target.value); setResult(null); setDefaultSaved(false) }}>{ids.map(id => <option key={id} value={id}>{provider.models.find(model => model.model === id)?.label || id}</option>)}</Select></Field>
    {!provider.credentialConfigured && <p className="notice">{uiT('尚未填写密钥。请在服务连接中补全后测试。')}</p>}
    {result && <StatusNotice compact tone={result.status === 'failed' ? 'error' : 'success'} title={uiT(result.status === 'failed' ? '连接测试未通过' : '连接测试通过')} details={uiT(result.message)} />}{defaultSaved && <p role="status">{uiT('已设为默认模型')}</p>}<ErrorNotice error={action.error} />
    <div className="inline-checks"><Button disabled={action.busy || !provider.credentialConfigured} onClick={() => void action.run(async () => { setResult(await api<ModelCheck>(`/settings/providers/${encodeURIComponent(providerId)}/test`, 'POST', { expectedRevision: catalog.revision, model: selected })); await refreshModels() })}>{action.busy ? uiT('正在处理…') : uiT('测试模型')}</Button><Button disabled={action.busy || !provider.credentialConfigured || defaultSaved} onClick={() => void action.run(async () => { await onDefault({ provider: providerId, model: selected }); setDefaultSaved(true) })}>{uiT('设为默认模型')}</Button></div><p className="muted">{uiT('测试会发送一条简短请求，可能消耗少量额度。')}</p><div className="form-actions"><Button tone="primary" disabled={action.busy} onClick={done}>{uiT('完成')}</Button></div>
  </div>
}
