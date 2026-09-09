import { useQuery } from '@tanstack/react-query'
import { Activity } from 'lucide-react'
import type { RunRecord } from '../../../../../packages/rp-core/src/types.ts'
import type { RunTrajectory } from '../../../../../packages/protocol/src/trace.ts'
import { api } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { ErrorNotice } from '../../components/ui.tsx'

import { isActive } from './trajectory/model.ts'

/** Reading mode offers a compact overview; the main trajectory owns full inspection. */
export function RoundProcess({ runId, run }: { runId: string; run?: RunRecord }) {
  useUiLanguage()
  const query = useQuery({ queryKey: ['run-trajectory', runId, ''], queryFn: ({ signal }) => api<RunTrajectory>(`/runs/${runId}/trajectory`, 'GET', undefined, signal), refetchInterval: isActive(run?.status) ? 1000 : false })
  return <div className="round-process">{query.data && <div className="round-process-summary"><Activity size={14} /><span>{uiT('%{count} 次模型请求', { count: query.data.requests.length })} · {uiT('%{count} 次工具调用', { count: query.data.entries.filter(entry => !entry.history && entry.kind === 'tool').length })}</span></div>}<ErrorNotice source="read" title={uiT('本轮轨迹暂时无法读取')} error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} /></div>
}
