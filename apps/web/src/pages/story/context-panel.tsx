
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RunRecord, StoryEvent } from '../../../../../packages/rp-core/src/types.ts'
import { api } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { ErrorNotice, Empty, Loading } from '../../components/ui.tsx'
import { RunSelector, useRunHistory } from './run-history.tsx'
import { ContextRecord } from './context-record.tsx'

export function ContextPanel({ storyId, runs }: { storyId: string; runs: RunRecord[] }) {
  useUiLanguage()
  const [selected, setSelected] = useState<string | null>(null), runId = selected ?? runs[0]?.id ?? ''
  const query = useQuery({ queryKey: ['context', runId], enabled: !!runId, queryFn: ({ signal }) => api<{ contexts: StoryEvent[] }>(`/runs/${runId}/context`, 'GET', undefined, signal) })
  const history = useRunHistory(storyId, runs)
  return <div className="stack"><header className="inspector-intro"><h3>{uiT('这次回复参考了什么')}</h3><p>{uiT('生成时保存的上下文，后续修改资料不会改变它。')}</p></header>{!!runId && <RunSelector history={history} selected={runId} onChange={setSelected} />}<ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />{query.isLoading && <Loading />}{query.data?.contexts.map(event => <ContextRecord key={event.seq} event={event} />)}{!runId ? <Empty title={uiT('发送第一条消息后可查看')} /> : !query.error && query.data?.contexts.length === 0 && <Empty title={uiT('这次运行还没有上下文记录')} />}</div>
}
