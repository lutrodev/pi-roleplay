import type { ReactNode } from 'react'
import { ChevronDown, History } from 'lucide-react'
import type { TrajectoryRound } from '../../../../../../packages/protocol/src/trace.ts'
import { uiLocale, uiT } from '../../../lib/i18n.ts'
import { Button, ErrorNotice, Loading, Menu, MenuItem } from '../../../components/ui.tsx'
import { duration, isActive, statusLabels } from './model.ts'
import { StatusIcon } from './ledger.tsx'

export function RoundLedger({ round, now, children, viewingAttempt, chooseAttempt, loading, error, retry }: {
  round: TrajectoryRound; now: number; children: ReactNode; viewingAttempt?: number
  chooseAttempt?: (runId: string | null) => void; loading?: boolean; error?: Error | null; retry?: () => void
}) {
  const { run } = round.trajectory, attempt = viewingAttempt ?? round.attempts.length
  const history = round.attempts.filter(attempt => attempt.disposition !== 'current'), inputOnly = round.state === 'input-only' && !viewingAttempt
  const historical = !!viewingAttempt || round.state === 'deleted', selected = round.attempts[attempt - 1]
  const elapsed = Math.max(0, (isActive(run.status) ? now : Date.parse(run.updatedAt)) - Date.parse(run.createdAt))
  return <section className="trajectory-round" data-run-id={run.id} data-round-id={round.id} data-historical={historical || undefined} aria-label={uiT(round.state === 'deleted' ? '原第 %{round} 轮（已删除）' : '第 %{round} 轮', { round: round.round })}>
    <div className="trajectory-round-rail"><span>{uiT(round.state === 'deleted' ? '原第 %{round} 轮' : '第 %{round} 轮', { round: round.round })}</span>{round.state === 'deleted' && <small>{uiT('已删除')}</small>}</div>
    <div className="trajectory-round-body">
      <header className="trajectory-round-heading"><time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString(uiLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
        {inputOnly ? <span>{uiT('回复已删除 · 保留输入')}</span> : !loading && !error && <><span className="trajectory-status" data-status={run.status}><StatusIcon status={run.status} />{uiT(statusLabels[run.status])}</span><time>{duration(elapsed)}</time></>}
        {round.attempts.length > 1 && <span>{uiT('第 %{attempt} 次尝试', { attempt })}</span>}
        {history.length > (round.state === 'deleted' ? 1 : 0) && chooseAttempt && <Menu label={uiT('选择历史尝试')} trigger={<Button tone="quiet" className="trajectory-attempt-trigger"><History size={13} />{uiT('历史尝试 %{count}', { count: history.length })}<ChevronDown size={12} /></Button>}>
          {viewingAttempt && round.state !== 'deleted' && <MenuItem onSelect={() => chooseAttempt(null)}>{uiT('返回当前轨迹')}</MenuItem>}
          {history.map(item => <MenuItem key={item.runId} onSelect={() => chooseAttempt(item.runId)}>{uiT('第 %{attempt} 次尝试', { attempt: item.attempt })} · {uiT(item.disposition === 'deleted' ? '已删除' : '已被替换')}</MenuItem>)}
        </Menu>}
      </header>
      {historical && <div className="trajectory-history-notice"><History size={13} /><span>{uiT('正在查看第 %{attempt} 次尝试 · %{state}', { attempt, state: uiT(selected?.disposition === 'deleted' ? '已删除' : selected?.disposition === 'superseded' ? '已被替换' : '当前尝试') })}</span>{viewingAttempt && round.state !== 'deleted' && <Button tone="quiet" onClick={() => chooseAttempt?.(null)}>{uiT('返回当前轨迹')}</Button>}</div>}
      {loading ? <Loading /> : error ? <ErrorNotice error={error} retry={retry} /> : <>{!inputOnly && run.error && <p className="trajectory-run-error" data-status={run.status}>{run.error.message}</p>}{children}</>}
    </div>
  </section>
}
