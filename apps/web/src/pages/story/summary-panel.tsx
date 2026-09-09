
import { useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { BookOpen } from 'lucide-react'
import type { StoryEvent, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import type { RecapPage } from '../../../../../packages/protocol/src/reading.ts'
import { api } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { ErrorNotice, Button, Empty, JsonView, Loading } from '../../components/ui.tsx'
import { Markdown } from '../../components/markdown.tsx'
import { SummaryFeedback } from './maintenance-feedback.tsx'

export function SummaryPanel({ story }: { story: StorySnapshot }) {
  useUiLanguage()
  const [recordsOpen, setRecordsOpen] = useState(false)
  const id = story.maintenance.summary?.id
  const query = useQuery({ queryKey: ['summary-record', story.id, id], enabled: !!id && recordsOpen, queryFn: ({ signal }) => api<{ records: StoryEvent[] }>(`/stories/${story.id}/summaries/${id}`, 'GET', undefined, signal) })
  const recaps = useInfiniteQuery({ queryKey: ['story-recap', story.id], initialPageParam: null as string | null, queryFn: ({ pageParam, signal }) => api<RecapPage>(`/stories/${story.id}/recap${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`, 'GET', undefined, signal), getNextPageParam: page => page.before ?? undefined })
  const covered = new Set(story.checkpoint?.sourceMessageIds)
  const recent = (recaps.data?.pages.flatMap(page => page.items) ?? []).filter(summary => !covered.has(summary.messageId))
  return <div className="summary-reader">
    <header className="summary-overview">
      <span className="summary-overview-icon" aria-hidden="true"><BookOpen size={19} /></span>
      <div><h3>{uiT('故事走到了哪里')}</h3><p>{uiT('回顾已经发生的事，接上当前的剧情。')}</p></div>
      {story.checkpoint && <small>{uiT('涵盖 %{count} 条消息', { count: story.checkpoint.sourceMessageIds.length })}</small>}
    </header>
    {story.checkpoint && <section className="summary-checkpoint" aria-label={uiT('会话总结')}><Markdown text={story.checkpoint.text} /><p className="material-footnote">{uiT('原文仍保留在会话中。')}</p></section>}
    <ErrorNotice source="read" error={recaps.error} retry={() => void recaps.refetch()} retrying={recaps.isFetching} />{recaps.isPending && <Loading />}
    {recent.length > 0 && <section className="summary-recent"><header><h4>{uiT('近期剧情')}</h4><span>{uiT('从新到旧')}</span></header><ol>{recent.map((summary, index) => <li key={summary.messageId}><span className="summary-step">{index === 0 ? uiT('最近') : uiT('更早')}</span><Markdown text={summary.text} /></li>)}</ol>{recaps.hasNextPage && <Button tone="quiet" disabled={recaps.isFetchingNextPage} onClick={() => void recaps.fetchNextPage()}>{uiT(recaps.isFetchingNextPage ? '正在读取…' : '继续阅读更早的剧情')}</Button>}<p className="material-footnote">{uiT('这些回顾记录于回复生成时。')}</p></section>}
    {!story.checkpoint && recaps.isSuccess && !recent.length && <Empty icon={<BookOpen size={24} />} title={uiT('故事回顾会出现在这里')}>{uiT('有剧情回复或会话总结后，就可以在这里阅读。')}</Empty>}
    <SummaryFeedback summary={story.maintenance.summary} showReady />
    {id && <details className="context-section summary-records" open={recordsOpen} onToggle={event => setRecordsOpen(event.currentTarget.open)}><summary>{uiT('最近一次总结记录')}</summary>{recordsOpen && <><ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />{query.isPending && <Loading />}{query.data && <JsonView value={query.data.records} />}</>}</details>}
  </div>
}
