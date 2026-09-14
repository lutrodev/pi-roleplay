import { useEffect, useId, useState } from 'react'
import { Collapsible } from 'radix-ui'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowUpRight, Bot, ChevronRight } from 'lucide-react'
import type { AgentActivity, RunActivitySnapshot } from '../../../../../packages/protocol/src/activity.ts'
import type { RunRecord } from '../../../../../packages/rp-core/src/types.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { Button } from '../../components/ui.tsx'
import { StatusIcon } from './trajectory/ledger.tsx'
import { duration, statusLabels } from './trajectory/model.ts'
import { activityToolName, agentStatusLabel } from './activity-labels.ts'

export function useActivityClock(active: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { if (!active) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [active])
  return now
}
export function quietActivity(agent: AgentActivity, now: number) {
  return agent.status === 'running' && !['queued', 'waiting_user'].includes(agent.phase) && now - Date.parse(agent.updatedAt) >= 30_000
}

/** Small invocation rows stay readable during parallel work; details never become story prose. */
export function SubagentProgress({ run, snapshot, synchronized, inspect }: {
  run: RunRecord; snapshot?: RunActivitySnapshot; synchronized: boolean; inspect: (callId: string) => void
}) {
  useUiLanguage()
  const [choice, setChoice] = useState<boolean | null>(null), reduced = useReducedMotion()
  const agents = snapshot?.runId === run.id ? snapshot.agents : []
  const running = agents.filter(agent => agent.status === 'running').length
  const failed = agents.filter(agent => agent.status === 'failed' || agent.status === 'interrupted').length
  const now = useActivityClock(running > 0 && synchronized)
  if (!agents.length) return null
  const open = choice ?? (running > 0 || failed > 0)
  const summary = !synchronized ? uiT('上次同步的进展') : running ? uiT('%{count} 项进行中', { count: running })
    : failed ? uiT('%{count} 项未完成', { count: failed }) : uiT('协作已结束')
  return <Collapsible.Root className="subagent-progress" open={open} onOpenChange={setChoice}>
    <Collapsible.Trigger className="subagent-progress-heading">
      <Bot size={15} aria-hidden="true" /><span>{uiT('协作进展')}</span><span className="subagent-progress-count" role="status" aria-live="polite">{summary} · {uiT('共 %{count} 项', { count: agents.length })}</span>
      <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: reduced ? 0 : .14 }}><ChevronRight size={14} /></motion.span>
    </Collapsible.Trigger>
    <Collapsible.Content className="subagent-progress-list">
      {agents.map(agent => <AgentProgressRow key={agent.callId} agent={agent} now={now} synchronized={synchronized} reading={() => setChoice(true)} inspect={() => inspect(agent.callId)} />)}
    </Collapsible.Content>
  </Collapsible.Root>
}
function AgentProgressRow({ agent, now, synchronized, inspect, reading }: { agent: AgentActivity; now: number; synchronized: boolean; inspect: () => void; reading: () => void }) {
  const [open, setOpen] = useState(false), reduced = useReducedMotion(), id = useId()
  const quiet = synchronized && quietActivity(agent, now)
  const label = agentStatusLabel(agent), elapsed = Math.max(0, (agent.finishedAt ? Date.parse(agent.finishedAt) : synchronized ? now : Date.parse(agent.updatedAt)) - Date.parse(agent.startedAt))
  const status = synchronized && !quiet && agent.phase !== 'queued' ? agent.status : agent.status === 'running' ? 'queued' : agent.status
  return <Collapsible.Root className="subagent-progress-item" data-status={agent.status} open={open} onOpenChange={value => { setOpen(value); if (value) reading() }}>
    <Collapsible.Trigger className="subagent-progress-row" aria-label={uiT('%{name}：%{status}，查看协作详情', { name: agent.name, status: label })} aria-describedby={quiet ? id : undefined}>
      <StatusIcon status={status} /><strong>{agent.name}</strong><span className="subagent-progress-status">{label}</span><time>{duration(elapsed)}</time>
      <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: reduced ? 0 : .14 }}><ChevronRight size={13} /></motion.span>
    </Collapsible.Trigger>
    {quiet && <p className="subagent-progress-quiet" id={id}>{uiT('已 %{count} 秒没有新进展', { count: Math.floor((now - Date.parse(agent.updatedAt)) / 1000) })}</p>}
    <Collapsible.Content className="subagent-progress-detail">
      {agent.task && <p>{agent.task}</p>}
      <div className="subagent-progress-meta">{agent.model && <span>{agent.model}</span>}<span>{uiT('%{count} 次模型请求', { count: agent.requestCount })}</span><span>{uiT('%{count} 次工具调用', { count: agent.toolCount })}</span></div>
      {agent.text && <div className="subagent-progress-output"><small>{uiT('最新输出片段')}</small><p>{agent.text}</p></div>}
      {agent.tools.length > 0 && <ul className="subagent-progress-tools" aria-label={uiT('最近的工具活动')}>{agent.tools.map(tool => <li key={tool.callId}><span>{activityToolName(tool.name)}{tool.preview && ` · ${tool.preview}`}</span><small>{uiT(statusLabels[tool.status])}</small></li>)}</ul>}
      <Button tone="quiet" className="subagent-progress-inspect" onClick={inspect}>{uiT('查看完整轨迹')}<ArrowUpRight size={13} /></Button>
    </Collapsible.Content>
  </Collapsible.Root>
}
