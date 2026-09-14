import { useQuery } from '@tanstack/react-query'
import type { RunRecord } from '../../../../../packages/rp-core/src/types.ts'
import type { RunActivitySnapshot } from '../../../../../packages/protocol/src/activity.ts'
import { api } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { useSharedConnectionError } from '../../lib/connection-feedback.tsx'

import { activityToolName } from './activity-labels.ts'

/** Keep public model commentary explicitly in the process surface, never in Markdown prose. */
export function progressPresentation(run: RunRecord, snapshot?: RunActivitySnapshot) {
  const data = snapshot?.runId === run.id ? snapshot : undefined
  const request = data?.requests.findLast(request => request.status === 'running')
  const live = data?.live.find(item => item.requestId === request?.id)
  const tools = data?.tools.filter(tool => tool.status === 'running') ?? []
  const writer = request ? request.scope.startsWith('writer:') : tools.some(tool => tool.name === 'rp_write_turn')
  const owner = request?.scope === 'main' ? uiT('主模型') : writer ? 'Writer' : request ? uiT('子代理') : uiT('主模型')
  let title = uiT('正在准备本轮请求')
  if (run.status === 'queued') title = uiT('请求已排队，等待模型开始')
  else if (run.status === 'waiting_user') title = uiT('需要你确认信息后继续')
  else if (live?.phase === 'queued') title = uiT('%{name} 已排队，等待请求名额', { name: owner })
  else if (live?.phase === 'tool') title = uiT('准备调用：%{name}', { name: activityToolName(live.toolName ?? '') })
  else if (live?.phase === 'thinking') title = uiT('%{name} 正在思考', { name: owner })
  else if (request?.scope === 'main') title = run.draft ? uiT('主模型正在处理写作结果') : live?.phase === 'responding' ? uiT('主模型正在回应') : uiT('主模型正在处理请求')
  else if (writer) title = run.draft ? uiT('Writer 正在写作 · %{count} 字', { count: [...run.draft].length }) : uiT('Writer 正在准备正文')
  else if (request) title = uiT('子代理正在处理任务')
  else if (tools.length) title = activityToolName(tools.at(-1)!.name)
  else if (run.draft) title = uiT('正文已生成，正在完成后续步骤')
  const characters = request?.scope === 'main' && live?.text.trim() ? [...live.text.replace(/\s+/g, ' ').trim()] : []
  const text = characters.length ? (characters.length > 160 ? '…' : '') + characters.slice(-160).join('') : undefined
  const tool = tools.findLast(tool => !['rp_write_turn', 'rp_run_subagent'].includes(tool.name))
  const toolText = tool && `${activityToolName(tool.name)}${tool.preview ? ` · ${tool.preview}` : ''}`
  return { title, text, label: run.status === 'waiting_user' || run.status === 'queued' || live?.phase === 'queued' ? title : toolText ?? text ?? title }
}

export function RunProgressView({ run, snapshot, connection, unavailable }: {
  run: RunRecord; snapshot?: RunActivitySnapshot; connection: 'connecting' | 'live' | 'reconnecting'; unavailable?: boolean
}) {
  useUiLanguage()
  const sharedConnectionError = useSharedConnectionError()
  if (sharedConnectionError || connection !== 'live' || !['queued', 'running', 'waiting_user'].includes(run.status)) return null
  if (!unavailable && snapshot?.runId === run.id && snapshot.agents.some(agent => agent.status === 'running') && !snapshot.requests.some(request => request.scope === 'main' && request.status === 'running')) return null
  const progress = progressPresentation(run, snapshot)
  const label = unavailable ? uiT('实时进展暂时无法读取，可查看本轮轨迹') : progress.label
  // Show the newest sentence while streaming; inspection stays in the reply footer.
  const currentLine = label.split(/(?<=[。！？\n])/u).map(line => line.trim()).filter(Boolean).at(-1) ?? label
  return <section className="run-progress" aria-label={uiT('实时运行进展')}>
    <div className="run-progress-line" title={label}>
      <span className="run-progress-text" data-animated={!unavailable && run.status === 'running'}>{currentLine}</span>
    </div>
  </section>
}

export function modelRequestsQueued(run: RunRecord | undefined, snapshot?: RunActivitySnapshot) {
  return run?.status === 'running' && snapshot?.runId === run.id && snapshot.live.length > 0 && snapshot.live.every(item => item.phase === 'queued')
}

export function useLiveRunActivity(run: RunRecord | undefined, connection: 'connecting' | 'live' | 'reconnecting', visible: boolean) {
  const active = !!run && ['queued', 'running', 'waiting_user'].includes(run.status)
  return useQuery({ queryKey: ['run-activity', run?.id, run?.status], queryFn: ({ signal }) => api<RunActivitySnapshot>(`/runs/${run!.id}/activity`, 'GET', undefined, signal),
    placeholderData: previous => previous?.runId === run?.id ? previous : undefined,
    enabled: !!run && visible && connection === 'live', staleTime: 0, refetchInterval: active && visible && connection === 'live' ? 750 : false,
  })
}
