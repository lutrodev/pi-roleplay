import type { StoryEvent } from '../../../../../packages/rp-core/src/types.ts'
import { JsonView } from '../../components/ui.tsx'
import { uiT } from '../../lib/i18n.ts'

/** Readable views use the frozen event text verbatim; the full record remains available. */
export function ContextRecord({ event }: { event: StoryEvent }) {
  if (event.type !== 'context.built' && event.type !== 'context.compacted') return <JsonView value={event.data} />
  const data = event.data
  const sections = [
    { title: '主模型系统提示', text: data.systemPrompt },
    { title: '主模型上下文', text: data.parentPrompt },
    ...(event.type === 'context.built' ? [{ title: 'Writer 系统提示', text: event.data.writerSystemPrompt }, { title: 'Writer 上下文', text: event.data.writerPrompt }] : []),
    { title: '压缩摘要', text: data.summaryForParent },
  ].filter(section => section.text)
  return <section className="context-record">
    <header><h3>{uiT(event.type === 'context.compacted' ? '父模型压缩后续接' : '本轮上下文')}</h3><small>{event.type === 'context.built' ? `${event.data.model.provider} / ${event.data.model.model}` : `#${event.seq}`}</small></header>
    {sections.map(section => <details className="context-section" key={section.title}><summary>{uiT(section.title)}</summary><pre>{section.text}</pre></details>)}
    {!!data.parentHistory?.length && <details className="context-section"><summary>{uiT('历史消息')}<small>{data.parentHistory.length}</small></summary><div className="context-messages">{data.parentHistory.map(message => <div key={message.id}><small>{message.role}</small><pre>{message.text}</pre></div>)}</div></details>}
    {event.type === 'context.built' && !!event.data.sources.length && <details className="context-section"><summary>{uiT('资料来源')}<small>{event.data.sources.length}</small></summary><JsonView value={event.data.sources} /></details>}
    <details className="context-section context-raw"><summary>{uiT('原始记录')}</summary><JsonView value={event.data} /></details>
  </section>
}
