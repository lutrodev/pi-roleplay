import { useQuery } from '@tanstack/react-query'
import type { RunRecord } from '../../../../../packages/rp-core/src/types.ts'
import type { RunActivitySnapshot } from '../../../../../packages/protocol/src/activity.ts'
import { api } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'

export function activityToolName(name: string): string {
  return ({ rp_write_turn: uiT('Writer 写作'), rp_commit_turn: uiT('保存正文与剧情状态'), rp_reply: uiT('整理回复'),
    rp_run_subagent: uiT('子代理协作'), read: uiT('读取文件'), write: uiT('写入文件'), edit: uiT('编辑文件'),
    bash: uiT('执行命令'), web_search: uiT('搜索资料'), ask_user_question: uiT('向你确认信息'),
  } as Record<string, string>)[name] ?? name
}

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
  return { title, text, label: run.status === 'waiting_user' || run.status === 'queued' ? title : toolText ?? text ?? title }
}

export function RunProgressView({ run, snapshot, connection, unavailable }: {
  run: RunRecord; snapshot?: RunActivitySnapshot; connection: 'connecting' | 'live' | 'reconnecting'; unavailable?: boolean
}) {
  useUiLanguage()
  if (!['queued', 'running', 'waiting_user'].includes(run.status)) return null
  const progress = progressPresentation(run, snapshot), disconnected = connection !== 'live'
  const label = disconnected ? uiT('连接恢复后继续更新实时进展') : unavailable ? uiT('实时进展暂时无法读取，可查看本轮轨迹') : progress.label
  // Show the newest sentence while streaming; inspection stays in the reply footer.
  const currentLine = label.split(/(?<=[。！？\n])/u).map(line => line.trim()).filter(Boolean).at(-1) ?? label
  return <section className="run-progress" aria-label={uiT('实时运行进展')}>
    <div className="run-progress-line" title={label}>
      <span className="run-progress-text" data-animated={!disconnected && !unavailable && run.status === 'running'}>{currentLine}</span>
    </div>
  </section>
}

export function RunProgress({ run, connection, visible = true }: { run: RunRecord; connection: 'connecting' | 'live' | 'reconnecting'; visible?: boolean }) {
  const active = visible && ['queued', 'running', 'waiting_user'].includes(run.status)
  const query = useQuery({ queryKey: ['run-activity', run.id], queryFn: ({ signal }) => api<RunActivitySnapshot>(`/runs/${run.id}/activity`, 'GET', undefined, signal),
    enabled: active && connection === 'live', staleTime: 0, refetchInterval: active && connection === 'live' ? 750 : false,
  })
  return <RunProgressView run={run} snapshot={query.data} connection={connection} unavailable={!!query.error} />
}
