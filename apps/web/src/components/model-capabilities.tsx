import { Brain, Image, ScanText } from 'lucide-react'
import type { ModelInfo } from '../lib/api.ts'
import { uiT } from '../lib/i18n.ts'

export function tokenLabel(value: number) {
  return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : String(value)
}
export function ModelCapabilities({ model }: { model: Pick<ModelInfo, 'input' | 'reasoning' | 'contextWindow' | 'sources'> }) {
  return <span className="model-capabilities">
    {model.input.includes('image') && <span title={uiT('支持图片输入')}><Image size={13} aria-hidden="true" />{uiT('图片')}</span>}
    {model.reasoning && <span title={uiT('支持思考')}><Brain size={13} aria-hidden="true" />{uiT('思考')}</span>}
    {model.sources.contextWindow !== 'unknown' && <span title={uiT('上下文窗口：%{count} tokens', { count: model.contextWindow })}><ScanText size={13} aria-hidden="true" />{tokenLabel(model.contextWindow)}</span>}
    {(model.sources.input === 'unknown' || model.sources.reasoning === 'unknown' || model.sources.contextWindow === 'unknown' || model.sources.maxTokens === 'unknown') && <span className="model-capability-unknown">{uiT('部分能力待确认')}</span>}
  </span>
}
