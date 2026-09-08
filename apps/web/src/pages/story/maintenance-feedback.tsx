import { ChevronRight, Square } from 'lucide-react'
import type { MaintenanceRecord } from '../../../../../packages/rp-core/src/types.ts'
import { Button } from '../../components/ui.tsx'
import { StatusNotice } from '../../components/status-notice.tsx'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'

export function SummaryFeedback({ summary, inspect, stop, disabled = false, showReady = false }: {
  summary?: MaintenanceRecord; inspect?: () => void; stop?: () => void; disabled?: boolean; showReady?: boolean
}) {
  useUiLanguage()
  if (!summary) return null
  const running = summary.status === 'running' && summary.trigger === 'manual'
  const ready = showReady && summary.status === 'ready'
  const stopped = summary.status === 'discarded' && summary.code === 'SUMMARY_CANCELLED'
  if (!running && !ready && !['failed', 'discarded'].includes(summary.status)) return null
  const title = running ? uiT('正在整理会话总结') : ready ? uiT('总结已就绪') : summary.status === 'failed' ? uiT('总结未完成') : stopped ? uiT('总结已停止') : uiT('本次总结未采用')
  return <StatusNotice className="summary-feedback" title={title} tone={running ? 'busy' : summary.status === 'failed' ? 'error' : stopped ? 'paused' : 'info'} details={!running && !ready && summary.message ? uiT(summary.message) : undefined} actions={inspect || running && stop ? <>
    {running && stop && <Button disabled={disabled} onClick={stop}><Square size={12} />{uiT('停止总结')}</Button>}
    {inspect && <Button tone="quiet" onClick={inspect}>{uiT('查看总结')}<ChevronRight size={13} /></Button>}
  </> : undefined}><p>{running ? uiT('原文会完整保留，整理期间可先写下一条。') : ready ? uiT(summary.message ?? '前情总结已就绪，将在下一轮开始时校验并应用。') : uiT('原文和已有总结仍然保留。')}</p></StatusNotice>
}
