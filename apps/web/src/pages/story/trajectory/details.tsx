import { StatusNotice } from '../../../components/status-notice.tsx'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowLeft, Check, Copy, X } from 'lucide-react'
import type { StoryEvent } from '../../../../../../packages/rp-core/src/types.ts'
import type { ModelRequestSummary, TraceTool, TrajectoryEntry } from '../../../../../../packages/protocol/src/trace.ts'
import { api, useAction } from '../../../lib/api.ts'
import { uiLocale, uiT, useUiLanguage } from '../../../lib/i18n.ts'
import { ErrorNotice, IconButton, Loading } from '../../../components/ui.tsx'
import { asObject, asText, Blocks, ContentSection, Fields, ResultContent, TraceJson, TraceText, TraceSearch } from './content.tsx'
import { duration, isActive, roleLabels, statusLabels, toolLabels } from './model.ts'
import { HistoryDetail, RequestMessages, historyDetail } from './history.tsx'

interface DetailData { records?: StoryEvent[]; tool?: TraceTool; event?: StoryEvent }
type DetailTab = 'overview' | 'input' | 'output' | 'tools' | 'raw'
export function TraceDetails({ entry, runId, storyId, round, attempt, request, close, search }: {
  entry: TrajectoryEntry; runId: string; storyId: string; round?: number; attempt?: number; request?: ModelRequestSummary; close: () => void; search: string
}) {
  useUiLanguage()
  const reduced = useReducedMotion(), heading = useRef<HTMLButtonElement>(null), [tab, setTab] = useState<DetailTab>('overview')
  const content = useRef<HTMLDivElement>(null), positioned = useRef('')
  const action = useAction(), [copied, setCopied] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => { setTab('overview'); setCopied(false); heading.current?.focus({ preventScroll: true }) }, [entry.id])
  useEffect(() => () => clearTimeout(timer.current), [])
  const query = useQuery<DetailData>({ queryKey: ['trajectory-detail', runId, entry.detail, entry.status],
    refetchInterval: isActive(entry.status) ? 1000 : false,
    queryFn: ({ signal }) => api(entry.detail.type === 'request' ? `/runs/${runId}/requests/${entry.detail.requestId}` : entry.detail.type === 'tool' ? `/runs/${runId}/trajectory-tool?callId=${encodeURIComponent(entry.detail.callId)}` : `/stories/${storyId}/logs/${entry.detail.seq}`, 'GET', undefined, signal) })
  useLayoutEffect(() => {
    const key = `${entry.id}:${tab}:${search}`
    if (!content.current || !query.data || positioned.current === key) return
    positioned.current = key
    content.current.scrollTop = 0
    if (search) content.current.querySelector<HTMLElement>('.trajectory-searchable mark')?.scrollIntoView({ block: 'center' })
  }, [entry.id, tab, query.data, search])
  const data = query.data
  const sent = data?.records?.find(event => event.type === 'model.message' && event.data.role === 'provider:request')
  const received = data?.records?.find(event => event.type === 'model.message' && event.data.role === 'provider:response')
  const input = sent?.type === 'model.message' ? asObject(sent.data.message) : {}
  const output = received?.type === 'model.message' ? asObject(received.data.message.response) : {}
  const tabs: { id: DetailTab; label: string }[] = [{ id: 'overview', label: '概览' },
    ...(entry.history ? [{ id: 'input' as const, label: '预置消息' }, { id: 'output' as const, label: '预置结果' }] : entry.detail.type === 'request' ? [{ id: 'input' as const, label: '请求' }, { id: 'output' as const, label: '响应' }, { id: 'tools' as const, label: '工具定义' }] : entry.kind === 'tool' ? [{ id: 'input' as const, label: '参数' }, { id: 'output' as const, label: '结果' }] : []),
    { id: 'raw', label: '原始记录' }]
  const title = toolLabels[entry.title] ?? entry.title
  const copy = () => action.run(async () => {
    const history = historyDetail(entry, input)
    const value = tab === 'input' ? data?.tool?.arguments ?? input : tab === 'output' ? data?.tool?.result ?? output : tab === 'tools' ? input.tools : data
    await navigator.clipboard.writeText(history ? tab === 'input' ? history.callRaw ?? history.raw : tab === 'output' ? JSON.stringify(history.result ?? history.message, null, 2) : history.raw : JSON.stringify(value, null, 2)); setCopied(true)
    clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800)
  })
  return <motion.aside className="trajectory-details" aria-label={uiT('轨迹详情')} initial={{ opacity: 0, x: reduced ? 0 : 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reduced ? 0 : .16 }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
    <header className="trajectory-detail-heading"><IconButton label={uiT('返回轨迹列表')} className="trajectory-mobile-back" onClick={close}><ArrowLeft size={17} /></IconButton><span className="trajectory-role" data-kind={entry.kind}>{uiT(roleLabels[entry.kind])}</span><strong>{uiT(title)}</strong><IconButton ref={heading} label={uiT('关闭详情')} onClick={close}><X size={17} /></IconButton></header>
    <div className="trajectory-detail-meta">{round !== undefined && <span>{uiT('第 %{round} 轮', { round })}</span>}{attempt !== undefined && <span>{uiT('第 %{attempt} 次尝试', { attempt })}</span>}{entry.history && <span>{uiT('预置历史 · 第 %{round} 轮', { round: entry.history.round })}</span>}{entry.model && <span>{entry.model}</span>}{entry.status && <span className="trajectory-status" data-status={entry.status}>{uiT(statusLabels[entry.status])}</span>}<span>{duration(entry.elapsedMs)}</span><time>{new Date(entry.startedAt).toLocaleTimeString(uiLocale())}</time></div>
    <div className="trajectory-detail-tabs"><div role="tablist" aria-label={uiT('详情内容')} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const current = tabs.findIndex(item => item.id === tab), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      setTab(tabs[next]!.id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
    }}>{tabs.map(item => <button key={item.id} type="button" role="tab" tabIndex={tab === item.id ? 0 : -1} aria-selected={tab === item.id} aria-controls="trajectory-detail-content" onClick={() => setTab(item.id)}>{uiT(item.label)}</button>)}</div><IconButton label={copied ? uiT('已复制') : uiT('复制当前内容')} disabled={!data || action.busy} onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}</IconButton></div>
    <div ref={content} className="trajectory-detail-content" id="trajectory-detail-content" role="tabpanel" aria-label={uiT(tabs.find(item => item.id === tab)!.label)}>
      <ErrorNotice error={query.error ?? action.error} retry={() => void query.refetch()} retrying={query.isFetching} />{query.isPending && <Loading />}
      {search && <p className="trajectory-search-note">{uiT('正在查看搜索命中的记录：')}<mark>{search}</mark></p>}
      <TraceSearch value={search}><div className="trajectory-searchable">{data && <>{entry.history ? <HistoryDetail entry={entry} input={input} tab={tab} /> : tab === 'raw' ? <TraceJson value={data.records ?? data.tool ?? data.event} /> : entry.detail.type === 'request' ? <>
        {tab === 'overview' && <><RequestMetrics request={request} /><ContentSection title={entry.kind === 'system' ? '系统提示' : entry.kind === 'context' ? '请求消息' : '模型响应'}>{entry.kind === 'system' ? <TraceText text={asText(input.systemPrompt)} /> : entry.kind === 'context' ? <RequestMessages input={input} /> : <Blocks value={output.content} />}</ContentSection>{output.errorMessage != null && <StatusNotice compact tone="error" title={uiT('模型请求未完成')} details={asText(output.errorMessage)} />}</>}
        {tab === 'input' && <><ContentSection title="系统提示"><TraceText text={asText(input.systemPrompt) || uiT('未记录')} /></ContentSection><ContentSection title="请求消息"><RequestMessages input={input} /></ContentSection></>}
        {tab === 'output' && <><Blocks value={output.content} />{output.errorMessage != null && <StatusNotice compact tone="error" title={uiT('模型请求未完成')} details={asText(output.errorMessage)} />}</>}
        {tab === 'tools' && (Array.isArray(input.tools) && input.tools.length ? input.tools.map((value, index) => { const tool = asObject(value); return <details className="trajectory-tool-definition" key={index}><summary>{asText(tool.name)}</summary><p>{asText(tool.description)}</p><TraceJson value={tool.parameters} /></details> }) : <p className="muted">{uiT('这次请求没有工具定义。')}</p>)}
      </> : data.tool ? <>
        {(tab === 'overview' || tab === 'input') && <ContentSection title="调用参数"><Fields value={data.tool.arguments} /></ContentSection>}
        {(tab === 'overview' || tab === 'output') && <ContentSection title="返回结果"><ResultContent value={data.tool.result} />{data.tool.output && <details><summary>{uiT('执行中的输出')}</summary><TraceText text={data.tool.output} /></details>}</ContentSection>}
      </> : data.event && <EventContent event={data.event} />}</>}
    </div></TraceSearch></div><span className="sr-only" role="status">{copied ? uiT('已复制') : ''}</span>
  </motion.aside>
}
function RequestMetrics({ request }: { request?: ModelRequestSummary }) {
  if (!request) return null
  return <dl className="trajectory-metrics">{[['耗时', duration(request.elapsedMs)], ['首个内容', duration(request.firstTokenMs)], ['输入 tokens', request.usage?.input.toLocaleString(uiLocale()) ?? uiT('未记录')], ['输出 tokens', request.usage?.output.toLocaleString(uiLocale()) ?? uiT('未记录')], ['缓存读取', request.usage?.cacheRead.toLocaleString(uiLocale()) ?? uiT('未记录')], ['缓存写入', request.usage?.cacheWrite.toLocaleString(uiLocale()) ?? uiT('未记录')], ['费用估算（USD）', request.usage?.cost ? `$${request.usage.cost.total.toFixed(5)}` : uiT('未记录')]].map(([label, value]) => <div key={label}><dt>{uiT(label!)}</dt><dd>{value}</dd></div>)}</dl>
}
function EventContent({ event }: { event: StoryEvent }) {
  if (event.type === 'message.edited') return <><p className="notice">{uiT('当前编辑后的输入；模型请求详情仍保留当时发送的内容。')}</p><Blocks value={event.data.text} /></>
  if (event.type === 'message.added') return <><Blocks value={event.data.message.text} />{event.data.message.attachmentIds.map(id => <p key={id}><a className="trajectory-file-link" href={`/api/files/${id}/content`} target="_blank" rel="noopener noreferrer">{uiT('查看附件')}</a></p>)}</>
  if (event.type === 'turn.committed') return <><ContentSection title="剧情正文"><Blocks value={event.data.message.text} /></ContentSection><ContentSection title="状态更新">{event.data.stateUpdates.length ? event.data.stateUpdates.map(update => <section key={update.namespace}><h4>{update.namespace}</h4><Fields value={update.snapshot?.value} /></section>) : <p className="muted">{uiT('这次提交没有更新变量。')}</p>}</ContentSection><ContentSection title="提交效果"><Fields value={event.data.effects} /></ContentSection></>
  if (event.type === 'context.built' || event.type === 'context.compacted') return <TraceText text={event.data.parentPrompt} />
  return <TraceJson value={event.data} />
}
