import type { TrajectoryEntry } from '../../../../../../packages/protocol/src/trace.ts'
import { uiT } from '../../../lib/i18n.ts'
import { asObject, asText, Blocks, ContentSection, Fields, Messages, TraceText } from './content.tsx'

/** Use recorded JSON source, not browser numbers, when showing the full native request prefix. */
export function RequestMessages({ input }: { input: Record<string, unknown> }) {
  const exact = Array.isArray(input.historyMessagesJson) ? input.historyMessagesJson.map(asText) : []
  const messages = Array.isArray(input.messages) ? input.messages : []
  return <>{exact.length > 0 && <ContentSection title="Writer 预置历史"><TraceText text={`[\n${exact.join(',\n')}\n]`} /></ContentSection>}<Messages value={messages.slice(exact.length)} literal /></>
}

export function historyDetail(entry: TrajectoryEntry, input: Record<string, unknown>) {
  if (entry.detail.type !== 'request' || entry.detail.messageIndex === undefined) return undefined
  const index = entry.detail.messageIndex, messages = Array.isArray(input.messages) ? input.messages : []
  const message = asObject(messages[index]), block = asObject(Array.isArray(message.content) ? message.content[0] : undefined)
  const raw = (i: number) => Array.isArray(input.historyMessagesJson) ? asText(input.historyMessagesJson[i]) : JSON.stringify(messages[i], null, 2)
  const result = message.role === 'toolResult' ? message : block.type === 'toolCall' ? asObject(messages[index + 1]) : undefined
  const callIndex = message.role === 'toolResult' ? index - 1 : block.type === 'toolCall' ? index : undefined
  return { message, raw: raw(index), callRaw: callIndex === undefined ? undefined : raw(callIndex), result }
}

export function HistoryDetail({ entry, input, tab }: { entry: TrajectoryEntry; input: Record<string, unknown>; tab: string }) {
  const history = historyDetail(entry, input)
  if (!history) return null
  if (tab === 'raw') return <TraceText text={history.raw} />
  return <>
    {tab === 'overview' && <><p className="notice">{uiT('这是注入的预置历史，不是本次运行的工具执行或模型输出。')}</p><Fields value={input.writerHistory} /></>}
    {(tab === 'overview' || tab === 'input') && (history.callRaw ? <ContentSection title="原生工具调用"><TraceText text={history.callRaw} /></ContentSection> : <ContentSection title="预置消息"><Blocks value={history.message.content} /></ContentSection>)}
    {(tab === 'overview' || tab === 'output') && history.result && <ContentSection title="预置工具结果"><p>{`isError: ${history.result.isError === true}`}</p><TraceText text={Array.isArray(history.result.content) ? history.result.content.map(part => asText(asObject(part).text)).join('\n') : ''} /></ContentSection>}
    {tab === 'output' && !history.result && <Blocks value={history.message.content} />}
  </>
}
