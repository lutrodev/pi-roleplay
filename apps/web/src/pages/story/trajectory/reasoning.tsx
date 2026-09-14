import type { StoryEvent } from '../../../../../../packages/rp-core/src/types.ts'
import { reasoningLabel } from '../../../components/reasoning-control.tsx'
import { uiT } from '../../../lib/i18n.ts'
import { asObject, asText, ContentSection, TraceJson } from './content.tsx'

export function RequestReasoning({ input, records }: { input: Record<string, unknown>; records?: StoryEvent[] }) {
  const reasoning = asObject(input.reasoning)
  const wire = records?.filter(event => event.type === 'model.message' && event.data.role === 'provider:parameters') ?? []
  const source = reasoning.source === 'selection' ? '当前调用设置' : reasoning.source === 'model-default' ? '模型默认设置' : '服务默认'
  return <ContentSection title="思考设置">
    {reasoning.effective ? <dl className="trajectory-metrics"><div><dt>{uiT('生效值')}</dt><dd>{reasoningLabel(asText(reasoning.effective))}</dd></div><div><dt>{uiT('设置来源')}</dt><dd>{uiT(source)}</dd></div></dl>
      : <p className="muted">{uiT('旧记录仅包含 SDK 选项，无法确认实际发送的思考参数。')}</p>}
    {wire.map(event => event.type === 'model.message' && <div key={event.seq}><small>{uiT('实际请求参数')}</small>
      {Array.isArray(asObject(event.data.message.parameters).messages) && <p className="muted">{uiT('本次强度由最后一条消息级设置决定；此前设置保留历史，顶层值用于缓存。')}</p>}
      <TraceJson value={event.data.message.parameters} /></div>)}
    {Boolean(reasoning.effective) && wire.length === 0 && <p className="muted">{uiT('尚未生成实际请求参数。')}</p>}
  </ContentSection>
}
