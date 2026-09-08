import { useMemo } from 'react'
import type { TrajectoryEntry, TrajectoryRound } from '../../../../../../packages/protocol/src/trace.ts'
import { uiT } from '../../../lib/i18n.ts'
import { duration, isError, roleLabels, timelinePositions } from './model.ts'
import { traceKey } from './conversation.ts'

export function TraceTimeline({ rounds, scope, actual, selected, select, now }: {
  rounds: TrajectoryRound[]; scope?: string; actual: boolean; selected: string | null; select: (round: TrajectoryRound, entry: TrajectoryEntry) => void; now: number
}) {
  const items = useMemo(() => rounds.flatMap(round => round.trajectory.entries.filter(entry => !entry.history && entry.agentId === (scope ?? 'main')).map(entry => ({ round, entry }))), [rounds, scope])
  const positions = useMemo(() => timelinePositions(items.map(item => item.entry), actual, now).map((position, index) => ({ ...position, round: items[index]!.round })), [items, actual, now])
  const lane = (entry: TrajectoryEntry) => entry.kind === 'assistant' ? 'model' : entry.kind === 'tool' || entry.kind === 'commit' ? 'tool' : 'input'
  const roundStarts = positions.filter((item, index) => !index || item.round.id !== positions[index - 1]!.round.id)
  return <section className="trajectory-timeline" aria-label={uiT('轨迹时间概览')}>
    {(['input', 'model', 'tool'] as const).map(kind => <div className="trajectory-lane" key={kind}><span>{uiT({ input: '输入', model: '模型', tool: '工具' }[kind])}</span><div className="trajectory-track">
      {roundStarts.map(({ round, left }) => <span className="trajectory-round-tick" aria-hidden="true" key={round.id} style={{ left: `${left}%` }} />)}
      {positions.filter(({ entry }) => lane(entry) === kind).map(({ entry, round, left, width }) => <button key={traceKey(round.trajectory.run.id, entry.id)} type="button" className="trajectory-span" data-kind={entry.kind} data-error={isError(entry) || undefined} data-active={selected === traceKey(round.trajectory.run.id, entry.id) || undefined} aria-label={`${uiT(round.state === 'deleted' ? '原第 %{round} 轮（已删除）' : '第 %{round} 轮', { round: round.round })} · ${uiT(roleLabels[entry.kind])} · ${entry.model ?? uiT(entry.title)} · ${duration(entry.elapsedMs)}`} title={`${uiT(round.state === 'deleted' ? '原第 %{round} 轮（已删除）' : '第 %{round} 轮', { round: round.round })} · ${uiT(entry.title)} · ${duration(entry.elapsedMs)}${entry.preview ? '\n' + entry.preview : ''}`} style={{ left: `${Math.min(99.5, left)}%`, width: `max(3px, ${Math.min(width, 100 - left)}%)` }} onClick={() => select(round, entry)} />)}
    </div></div>)}
    <div className="trajectory-timeline-caption">{uiT(actual ? '按实际时间排列；重叠表示并行' : '按步骤排列；色块宽度不代表耗时')}</div>
  </section>
}
