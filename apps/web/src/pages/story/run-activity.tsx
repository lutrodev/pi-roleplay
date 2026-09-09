import { LoaderCircle, MessageCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RunRecord, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import type { ActiveTool } from '../../../../../packages/protocol/src/reading.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { useSharedConnectionError } from '../../lib/connection-feedback.tsx'

type ActivityStory = Pick<StorySnapshot, 'archived' | 'messages' | 'maintenance'>
type Connection = 'connecting' | 'live' | 'reconnecting'
type Phase = 'queued' | 'preparing' | 'writing' | 'working' | 'collaborating' | 'finishing' | 'summary' | 'waiting' | 'reconnecting'

/** Use persisted work state, so draft growth, refreshes and child calls cannot end the indicator early. */
export function runActivityPhase(story: ActivityStory, run: RunRecord | undefined, activeTools: readonly ActiveTool[], connection: Connection = 'live'): Phase | null {
  if (story.archived) return null
  const active = run && ['queued', 'running', 'waiting_user'].includes(run.status)
  const summary = story.maintenance.summary
  const summarizing = summary?.status === 'running' && (summary.trigger === 'manual' || summary.runId === run?.id)
  let phase: Phase | null = null
  if (active) {
    const tools = activeTools.filter(tool => tool.runId === run.id)
    if (run.status === 'waiting_user') phase = 'waiting'
    else if (run.status === 'queued') phase = 'queued'
    else if (summarizing) phase = 'summary'
    else if (tools.some(tool => tool.name === 'rp_write_turn')) phase = 'writing'
    else if (tools.some(tool => tool.name === 'rp_commit_turn') || story.messages.some(message => message.runId === run.id && message.role === 'assistant' && ['narrative', 'message'].includes(message.kind))) phase = 'finishing'
    else if (tools.some(tool => tool.name === 'rp_run_subagent')) phase = 'collaborating'
    else if (tools.length) phase = 'working'
    else phase = run.draft ? 'finishing' : 'preparing'
  } else if (summarizing && (summary.trigger === 'manual' || run?.status === 'completed')) phase = 'summary'
  return phase && connection !== 'live' ? 'reconnecting' : phase
}

export function RunActivity({ story, run, activeTools, connection = 'live' }: { story: ActivityStory; run?: RunRecord; activeTools: readonly ActiveTool[]; connection?: Connection }) {
  useUiLanguage()
  const sharedConnectionError = useSharedConnectionError()
  const phase = runActivityPhase(story, run, activeTools, connection)
  // Manual summaries already expose their progress and stop action in SummaryFeedback.
  const manualSummary = story.maintenance.summary?.status === 'running' && story.maintenance.summary.trigger === 'manual'
  if (sharedConnectionError || !phase || phase === 'reconnecting' || manualSummary && !['queued', 'waiting_user'].includes(run?.status ?? '')) return null
  const copy: Record<Exclude<Phase, 'reconnecting'>, string> = {
    queued: uiT('等待开始…'),
    preparing: uiT('正在构思…'),
    writing: uiT('正在写作…'),
    working: uiT('正在处理…'),
    collaborating: uiT('正在协作…'),
    finishing: uiT('正在完成后续处理…'),
    summary: uiT('正在整理上下文…'),
    waiting: uiT('等待你的回答'),
  }
  return <div className="run-activity" data-phase={phase} role="status" aria-live="polite" aria-atomic="true">
    {phase === 'waiting' ? <MessageCircle className="run-activity-icon" size={14} aria-hidden="true" /> : <LoaderCircle className="run-activity-icon spinner" size={14} aria-hidden="true" />}
    <span>{copy[phase]}</span>
    {run && ['queued', 'running'].includes(run.status) && <ActivityDuration startedAt={run.createdAt} />}
  </div>
}

function ActivityDuration({ startedAt }: { startedAt: string }) {
  const start = Date.parse(startedAt), [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [startedAt])
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  if (!Number.isFinite(seconds) || seconds < 15) return null
  return <span className="run-activity-duration" aria-hidden="true">{seconds < 60 ? uiT('%{count} 秒', { count: seconds }) : uiT('%{minutes} 分 %{seconds} 秒', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })}</span>
}
