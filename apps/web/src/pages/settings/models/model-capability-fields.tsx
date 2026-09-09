import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RotateCcw, RefreshCw } from 'lucide-react'
import { Button, ErrorNotice, Field, Input, Select } from '../../../components/ui.tsx'
import { api, type ModelInfo } from '../../../lib/api.ts'
import { uiT } from '../../../lib/i18n.ts'
import { tokenLabel } from '../../../components/model-capabilities.tsx'
import type { MetadataSource } from '../../../../../../apps/server/src/runtime/model-metadata.ts'
import type { ModelFields } from './catalog.ts'

const sourceLabel = (source?: MetadataSource) => uiT(source === 'provider' ? '服务提供' : source === 'catalog' ? '模型目录' : source === 'manual' ? '手动设置' : '未识别')
export function useModelMetadata(provider: string, model: ModelFields, discoveryId?: string) {
  const input = { provider, model: model.model.trim(), connection: { api: model.api, baseUrl: model.baseUrl }, discoveryId }
  const serialized = JSON.stringify(input), [debounced, setDebounced] = useState(serialized)
  useEffect(() => { const timer = setTimeout(() => setDebounced(serialized), 250); return () => clearTimeout(timer) }, [serialized])
  return useQuery({ queryKey: ['model-metadata', debounced], enabled: !!input.model && !!input.connection.baseUrl && serialized === debounced,
    queryFn: ({ signal }) => api<ModelInfo>('/settings/models/metadata', 'POST', JSON.parse(debounced), signal) })
}

export function ModelCapabilityFields({ model, patch, auto, loading, onRefresh, refreshing, error, retry }: {
  model: ModelFields; patch: (next: Partial<ModelFields>) => void; auto?: ModelInfo; loading: boolean
  onRefresh?: () => void; refreshing: boolean; error: Error | null; retry: () => void
}) {
  const manual = ['label', 'input', 'reasoning', 'contextWindow', 'maxTokens'].some(key => model[key as keyof ModelFields] !== undefined && model[key as keyof ModelFields] !== '')
  const booleanValue = (key: 'input' | 'reasoning') => !auto || auto.sources[key] === 'unknown' ? uiT('未识别') : (key === 'input' ? auto.input.includes('image') : auto.reasoning) ? uiT('支持') : uiT('不支持')
  const help = (key: keyof ModelInfo['sources']) => model[key] !== undefined ? auto?.sources[key] && auto.sources[key] !== 'unknown' ? uiT('手动覆盖 · 自动值来自%{source}', { source: sourceLabel(auto.sources[key]) }) : uiT('手动设置') : sourceLabel(auto?.sources[key])
  return <section className="model-capability-settings" aria-label={uiT('模型能力')}>
    <div className="model-section-heading"><div><h3>{uiT('模型能力')}</h3><p>{loading || refreshing ? uiT('正在识别模型信息…') : uiT('自动识别，可按需覆盖。')}</p></div><div className="model-section-actions">
      {manual && <Button tone="quiet" onClick={() => patch({ label: undefined, input: undefined, reasoning: undefined, contextWindow: undefined, maxTokens: undefined })}><RotateCcw size={13} />{uiT('恢复自动')}</Button>}
      {onRefresh && <Button tone="quiet" disabled={refreshing} onClick={onRefresh}><RefreshCw size={13} className={refreshing ? 'spin' : undefined} />{uiT('刷新识别')}</Button>}
    </div></div>
    <div className="model-capability-rows">
      <Field layout="row" label={uiT('图片输入')} help={help('input')}><Select value={model.input === undefined ? 'auto' : model.input.includes('image') ? 'yes' : 'no'} onChange={event => patch({ input: event.target.value === 'auto' ? undefined : event.target.value === 'yes' ? ['text', 'image'] : ['text'] })}><option value="auto">{uiT('自动 · %{value}', { value: booleanValue('input') })}</option><option value="yes">{uiT('手动开启')}</option><option value="no">{uiT('手动关闭')}</option></Select></Field>
      <Field layout="row" label={uiT('思考能力')} help={help('reasoning')}><Select value={model.reasoning === undefined ? 'auto' : model.reasoning ? 'yes' : 'no'} onChange={event => patch({ reasoning: event.target.value === 'auto' ? undefined : event.target.value === 'yes' })}><option value="auto">{uiT('自动 · %{value}', { value: booleanValue('reasoning') })}</option><option value="yes">{uiT('手动开启')}</option><option value="no">{uiT('手动关闭')}</option></Select></Field>
      {([['contextWindow', '上下文窗口', 1024], ['maxTokens', '最大输出', 1]] as const).map(([key, label, min]) => <Field key={key} layout="row" label={uiT(label)} help={model[key] === undefined && auto?.sources[key] === 'unknown' ? uiT('未识别 · 暂用 %{value}', { value: tokenLabel(auto[key]) }) : help(key)}><div className="model-number-control"><Input type="number" min={min} step={1} value={model[key] ?? ''} placeholder={auto ? uiT('自动 · %{value}', { value: tokenLabel(auto[key]) }) : uiT('自动')} onChange={event => patch({ [key]: event.target.value ? Number(event.target.value) : undefined })} />{model[key] !== undefined && <Button tone="quiet" aria-label={uiT('%{label}恢复自动', { label: uiT(label) })} onClick={() => patch({ [key]: undefined })}><RotateCcw size={13} /></Button>}</div></Field>)}
    </div>
    {auto && (auto.sources.input === 'unknown' || auto.sources.reasoning === 'unknown') && <p className="model-detection-note">{uiT('未识别的能力暂不开启。服务未提供信息时，可根据其说明手动设置。')}</p>}
    <ErrorNotice source="read" error={error} retry={retry} retrying={loading || refreshing} />
  </section>
}
