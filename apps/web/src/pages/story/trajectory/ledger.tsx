import type { CSSProperties } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { CheckCircle2, CircleAlert, ChevronRight, ArrowUpRight, Circle, LoaderCircle, PauseCircle } from 'lucide-react'
import type { TrajectoryAgent, TrajectoryEntry } from '../../../../../../packages/protocol/src/trace.ts'
import { uiT } from '../../../lib/i18n.ts'
import { duration, isActive, isError, roleLabels, statusLabels, toolLabels } from './model.ts'

export function Highlight({ text, search }: { text: string; search: string }) {
  if (!search) return <>{text}</>
  const lower = text.toLocaleLowerCase(), needle = search.toLocaleLowerCase(), parts = []
  let from = 0, index = lower.indexOf(needle)
  while (index >= 0) { parts.push(text.slice(from, index), <mark key={index}>{text.slice(index, index + search.length)}</mark>); from = index + search.length; index = lower.indexOf(needle, from) }
  parts.push(text.slice(from)); return <>{parts}</>
}
export function StatusIcon({ status }: { status?: string }) {
  const reduced = useReducedMotion()
  if (isActive(status)) return <motion.span className="trajectory-status-icon" animate={status === 'running' && !reduced ? { rotate: 360 } : { rotate: 0 }} transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}><LoaderCircle size={13} /></motion.span>
  const Icon = status === 'completed' ? CheckCircle2 : status === 'failed' || status === 'truncated' ? CircleAlert : status === 'interrupted' || status === 'cancelled' ? PauseCircle : Circle
  return <Icon size={13} />
}
export function LedgerEntry({ entry, rowId = entry.id, agent, depth, selected, expanded, matched, search, select, toggle, enter }: {
  entry: TrajectoryEntry; rowId?: string; agent?: TrajectoryAgent; depth: number; selected: boolean; expanded: boolean; matched: boolean; search: string
  select: () => void; toggle: () => void; enter: () => void
}) {
  const reduced = useReducedMotion(), title = toolLabels[entry.title] ?? entry.title
  return <div className="trajectory-record" data-entry-id={rowId} data-selected={selected || undefined} data-error={isError(entry) || undefined} data-match={search && matched || undefined} style={{ '--trace-depth': Math.min(depth, 4) } as CSSProperties}>
    <div className="trajectory-branch">{agent ? <button type="button" aria-label={uiT(expanded ? '收起 %{name} 的过程' : '展开 %{name} 的过程', { name: agent.name })} aria-expanded={expanded} onClick={toggle}><motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: reduced ? 0 : .14 }}><ChevronRight size={14} /></motion.span></button> : <span className="trajectory-dot" />}</div>
    <button type="button" className="trajectory-row-main" aria-pressed={selected} aria-label={`${uiT(roleLabels[entry.kind])} · ${entry.model ?? uiT(title)}${entry.status ? ' · ' + uiT(statusLabels[entry.status]) : ''}`} onClick={select}>
      <span className="trajectory-role" data-kind={entry.kind}>{uiT(roleLabels[entry.kind])}</span>
      <span className="trajectory-row-content">
        {entry.history && <small className="muted">{uiT('预置历史 · 第 %{round} 轮', { round: entry.history.round })}</small>}
        {entry.kind === 'tool' && <><strong><Highlight text={uiT(title)} search={search} /></strong><code className="trajectory-tool-name"><Highlight text={entry.title} search={search} /></code></>}
        {entry.kind === 'assistant' && <span className="trajectory-model-name"><Highlight text={entry.model ?? ''} search={search} /></span>}
        <span className="trajectory-preview"><Highlight text={entry.preview || (isActive(entry.status) ? uiT('正在等待返回…') : entry.kind === 'assistant' ? uiT('没有文本内容') : uiT(title))} search={search} /></span>
        {entry.resultPreview && <><span className="trajectory-result-arrow">→</span><span className="trajectory-result"><Highlight text={entry.resultPreview} search={search} /></span></>}
      </span>
      <span className="trajectory-row-tail">{entry.status && <span className="trajectory-status" data-status={entry.status} title={uiT(statusLabels[entry.status])}><StatusIcon status={entry.status} /><span>{uiT(statusLabels[entry.status])}</span></span>}{entry.elapsedMs !== undefined && <time>{duration(entry.elapsedMs)}</time>}</span>
    </button>
    {agent && <button type="button" className="trajectory-agent-link" aria-label={uiT('查看 %{name} 的完整轨迹', { name: agent.name })} onClick={enter}><span>{agent.name}</span><small>{agent.requestCount}</small>{agent.errorCount > 0 && <span className="trajectory-agent-error" title={uiT('%{count} 个内部异常', { count: agent.errorCount })}><CircleAlert size={12} />{agent.errorCount}</span>}<ArrowUpRight size={13} /></button>}
  </div>
}
