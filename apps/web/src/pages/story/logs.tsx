import { uiT, uiLocale, useUiLanguage } from "../../lib/i18n.ts"
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { LogSummary } from '../../../../../packages/protocol/src/trace.ts'
import { api } from '../../lib/api.ts'
import { Button, Empty, ErrorNotice, Field, Input, JsonView, Loading } from '../../components/ui.tsx'

export function StoryLogs({ storyId }: { storyId: string }) {
  useUiLanguage()
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [cursors, setCursors] = useState([0])
  const after = cursors.at(-1)!
  const listing = useQuery({ queryKey: ['story-logs', storyId, after, search], queryFn: ({ signal }) => api<{ records: LogSummary[]; nextCursor: number | null }>(`/stories/${storyId}/logs?after=${after}&q=${encodeURIComponent(search)}`, 'GET', undefined, signal) })
  return <div className="stack"><form className="form-grid" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); setCursors([0]) }}><Field label={uiT("搜索日志")}><Input value={query} maxLength={300} onChange={event => setQuery(event.target.value)} placeholder={uiT("事件类型、模型、工具或内容")} /></Field><div className="form-actions"><Button type="submit">{uiT("搜索日志")}</Button><a className="button" href={`/api/stories/${storyId}/export`}>{uiT("下载完整日志")}</a></div></form>
    <p className="muted">{uiT("日志保留当时的记录，包括失败和被修改的历史；下载文件为按事件顺序排列的 JSONL，不包含图片文件本身。")}</p><ErrorNotice source="read" error={listing.error} retry={() => void listing.refetch()} retrying={listing.isFetching} />{listing.isPending && <Loading />}
    {listing.data?.records.map(record => <LogItem key={record.seq} storyId={storyId} record={record} />)}{listing.data?.records.length === 0 && <Empty title={uiT("没有匹配的日志")} />}
    <div className="pagination"><Button disabled={cursors.length <= 1} onClick={() => setCursors(value => value.slice(0, -1))}>{uiT("上一页")}</Button><span>{uiT("第 %{page} 页", { page: cursors.length })}</span><Button disabled={listing.data?.nextCursor == null} onClick={() => setCursors(value => [...value, listing.data!.nextCursor!])}>{uiT("下一页")}</Button><Button onClick={() => void listing.refetch()}>{uiT("刷新")}</Button></div>
  </div>
}
function LogItem({ storyId, record }: { storyId: string; record: LogSummary }) {
  useUiLanguage()
  const [open, setOpen] = useState(false), query = useQuery({ queryKey: ['story-event', storyId, record.seq], enabled: open, queryFn: ({ signal }) => api<{ event: unknown }>(`/stories/${storyId}/logs/${record.seq}`, 'GET', undefined, signal) })
  return <details className="trace-call" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><strong>{record.seq} · {record.type}</strong><small>{new Date(record.createdAt).toLocaleString(uiLocale())} · {record.characters.toLocaleString(uiLocale())} {uiT(" 字符")}</small></summary>{open && <div className="trace-call-body"><ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />{query.isPending && <Loading />}{query.data && <JsonView value={query.data.event} />}</div>}</details>
}
