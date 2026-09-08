import { useQuery } from '@tanstack/react-query'
import { reasoningLabel } from '../../../components/reasoning-control.tsx'
import { ErrorNotice, Field, Select } from '../../../components/ui.tsx'
import { api, type ModelInfo } from '../../../lib/api.ts'
import { uiT } from '../../../lib/i18n.ts'
import type { ModelFields } from './catalog.ts'

export function ModelReasoning({ provider, model, onChange }: { provider: string; model: ModelFields; onChange: (reasoning?: boolean) => void }) {
  const connection = { api: model.api, baseUrl: model.baseUrl ?? '' }, id = model.model.trim()
  const query = useQuery({ queryKey: ['model-reasoning', provider, id, connection], enabled: Boolean(id && connection.baseUrl),
    queryFn: ({ signal }) => api<Pick<ModelInfo, 'thinkingLevels' | 'defaultThinkingLevel' | 'reasoningSource'>>('/settings/models/reasoning', 'POST', { provider, model: id, connection }, signal) })
  const info = query.data
  const help = !id ? uiT('填写模型 ID 后自动识别思考能力。') : !connection.baseUrl ? uiT('填写服务地址后自动识别思考能力。')
    : query.error ? uiT('暂时无法识别思考能力，可重试或手动设置。') : query.isPending ? uiT('正在识别思考能力…')
    : info?.reasoningSource === 'unknown' ? uiT('模型目录未收录这个 ID；确认服务支持后，可以手动开启。')
      : info?.thinkingLevels.some(level => level !== 'off') ? uiT('已识别：%{levels}。默认使用%{level}强度。', { levels: info.thinkingLevels.map(reasoningLabel).join('、'), level: reasoningLabel(info.defaultThinkingLevel) })
        : uiT('模型目录标记为不支持思考强度。')
  return <><Field label={uiT('思考能力')} help={help}><Select aria-label={uiT('思考能力')} value={model.reasoning === undefined ? 'auto' : String(model.reasoning)}
    onChange={event => onChange(event.target.value === 'auto' ? undefined : event.target.value === 'true')}>
    <option value="auto">{uiT('自动识别（默认）')}</option><option value="true">{uiT('手动开启')}</option><option value="false">{uiT('不支持思考')}</option>
  </Select></Field><ErrorNotice error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} /></>
}
