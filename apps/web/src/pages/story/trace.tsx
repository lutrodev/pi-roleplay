
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { ArrowDown, ArrowLeft, ChevronDown, ChevronRight, ChevronUp, Clock3, Download, Filter, Search, X, ChevronsUpDown } from 'lucide-react'
import type { RunRecord, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import type { TrajectoryEntry, TrajectoryRound } from '../../../../../packages/protocol/src/trace.ts'
import { uiLocale, uiT, useUiLanguage } from '../../lib/i18n.ts'
import { ErrorNotice, Button, Empty, IconButton, Input, Loading, Menu, MenuItem } from '../../components/ui.tsx'
import { agentPath, descendantIds, isActive, isError, ledgerRows, usageTotals } from './trajectory/model.ts'
import { LedgerEntry } from './trajectory/ledger.tsx'
import { TraceDetails } from './trajectory/details.tsx'
import { TraceTimeline } from './trajectory/timeline.tsx'
import { RoundLedger } from './trajectory/round.tsx'
import { traceKey, useConversationTrajectory, useHistoricalAttempts } from './trajectory/conversation.ts'

interface TraceScope { runId: string; id: string }
interface TraceLocation { selected: string | null; top: number; search: string; errors: boolean }
export function TracePanel({ story, runs, runId, onRunChange, visible, returnToConversation }: {
  story: StorySnapshot; runs: RunRecord[]; runId: string | null; onRunChange: (id: string | null) => void; visible: boolean; returnToConversation: () => void
}) {
  useUiLanguage()
  const [anchor, setAnchor] = useState(runId), [queryText, setQueryText] = useState(''), [search, setSearch] = useState(''), [errors, setErrors] = useState(false)
  const [scope, setScope] = useState<TraceScope | null>(null), [selected, setSelected] = useState<string | null>(null), [expanded, setExpanded] = useState(new Set<string>())
  const [collapsedMatches, setCollapsedMatches] = useState(new Set<string>())
  const [deleted, setDeleted] = useState(false), [attemptChoices, setAttemptChoices] = useState<Record<string, string>>({})
  const [actual, setActual] = useState(false), [detailWidth, setDetailWidth] = useState(46), [following, setFollowing] = useState(!runId), [atEnd, setAtEnd] = useState(true)
  const list = useRef<HTMLDivElement>(null), split = useRef<HTMLDivElement>(null), searchInput = useRef<HTMLInputElement>(null)
  const locations = useRef(new Map<string, TraceLocation>()), restoring = useRef<number | null>(null), pendingRow = useRef<string | null>(null), pendingRound = useRef<string | null>(null)
  const prepending = useRef<{ height: number; top: number; updatedAt: number } | null>(null), prior = useRef({ active: false, latest: 0 }), pendingLatest = useRef(false)
  const source = useConversationTrajectory(story.id, runs, visible, anchor, search, errors, deleted)
  const history = useHistoricalAttempts(source.rounds, attemptChoices, search, visible), { rounds } = history
  const { totalRounds } = source, active = source.rounds.some(round => round.state === 'active' && isActive(round.trajectory.run.status)), now = source.dataUpdatedAt
  const structure = useRef(source.revision)
  useEffect(() => { if (!source.data || structure.current === source.revision) return; structure.current = source.revision; setAttemptChoices({}); setSelected(null); setScope(null); locations.current.clear(); prepending.current = null; pendingRow.current = null; pendingRound.current = null }, [source.revision, !!source.data])
  const scopedRounds = useMemo(() => scope ? rounds.filter(round => round.trajectory.run.id === scope.runId) : rounds, [rounds, scope])
  const groups = useMemo(() => scopedRounds.map(round => {
    const data = round.trajectory, local = (set: Set<string>) => new Set(data.agents.filter(agent => set.has(traceKey(data.run.id, agent.id))).map(agent => agent.id))
    return { round, rows: ledgerRows(data, scope?.id ?? 'main', local(expanded), !!search, errors, local(collapsedMatches)) }
  }).filter(group => !(search || errors) || group.rows.length > 0 || history.states.has(group.round.id)), [scopedRounds, scope, expanded, search, errors, collapsedMatches])
  const scopedEntries = useMemo(() => scopedRounds.flatMap(round => {
    const ids = descendantIds(round.trajectory, scope?.id ?? 'main')
    return round.trajectory.entries.filter(entry => ids.has(entry.agentId)).map(entry => ({ round, entry, key: traceKey(round.trajectory.run.id, entry.id) }))
  }), [scopedRounds, scope])
  const matches = scopedEntries.filter(({ round, entry }) => round.trajectory.matches.includes(entry.id) && (!errors || isError(entry)))
  const selectedItem = scopedEntries.find(item => item.key === selected), parentRound = scope ? scopedRounds[0] : undefined
  const parent = parentRound?.trajectory.agents.find(agent => agent.id === scope?.id)
  const stats = usageTotals(scopedRounds.flatMap(round => {
    const ids = descendantIds(round.trajectory, scope?.id ?? 'main')
    return round.trajectory.requests.filter(request => ids.has(request.parentCallId ?? 'main'))
  }))
  const failures = scopedEntries.filter(({ entry }) => isError(entry)).length, toolCount = scopedEntries.filter(({ entry }) => !entry.history && entry.kind === 'tool').length
  const locationKey = scope ? traceKey(scope.runId, scope.id) : 'conversation'
  useEffect(() => { const timer = setTimeout(() => setSearch(queryText.trim()), 180); return () => clearTimeout(timer) }, [queryText])
  useEffect(() => setCollapsedMatches(new Set()), [scope, search, errors])
  useEffect(() => {
    if (!visible || !runId) return
    pendingLatest.current = false
    setScope(null); setSelected(null); setQueryText(''); setSearch(''); setErrors(false); setFollowing(false)
    if (!rounds.some(round => round.trajectory.run.id === runId)) setAnchor(runId)
    pendingRound.current = runId; onRunChange(null)
  }, [visible, runId])
  const enter = (next: TraceScope | null) => {
    if (next?.runId === scope?.runId && next?.id === scope?.id) return
    pendingLatest.current = false
    locations.current.set(locationKey, { selected, top: list.current?.scrollTop ?? 0, search: queryText, errors })
    const saved = locations.current.get(next ? traceKey(next.runId, next.id) : 'conversation')
    setScope(next); setSelected(saved?.selected ?? null); setQueryText(saved?.search ?? ''); setSearch(saved?.search.trim() ?? ''); setErrors(saved?.errors ?? false); setFollowing(false)
    restoring.current = saved?.top ?? 0
  }
  const select = (round: TrajectoryRound, entry: TrajectoryEntry) => {
    pendingLatest.current = false
    const data = round.trajectory, key = traceKey(data.run.id, entry.id), ancestors = agentPath(data, entry.agentId).map(agent => traceKey(data.run.id, agent.id))
    setSelected(key); setFollowing(false); setExpanded(current => new Set([...current, ...ancestors]))
    setCollapsedMatches(current => { const next = new Set(current); for (const id of ancestors) next.delete(id); return next })
    pendingRow.current = key
  }
  const closeDetail = () => { const id = selected; setSelected(null); requestAnimationFrame(() => { if (id) list.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${CSS.escape(id)}"] .trajectory-row-main`)?.focus({ preventScroll: true }) }) }
  const jump = () => { if (scope) enter(null); pendingLatest.current = true; setFollowing(true); if (list.current) list.current.scrollTop = list.current.scrollHeight }
  const loadOlder = () => {
    pendingLatest.current = false
    if (list.current) prepending.current = { height: list.current.scrollHeight, top: list.current.scrollTop, updatedAt: now }
    setFollowing(false); void source.fetchPreviousPage()
  }
  useEffect(() => {
    if (visible && following && !scope && !search && !errors && source.hasNextPage && !source.isFetching && !source.isError) void source.fetchNextPage()
  }, [visible, following, scope, search, errors, source.hasNextPage, source.isFetching, source.isError])
  useLayoutEffect(() => {
    if (!visible || !list.current) return
    const latest = rounds.at(-1)?.cursor ?? 0, followCompletion = prior.current.active, appended = prior.current.latest > 0 && latest > prior.current.latest
    prior.current = { active, latest }
    if (restoring.current !== null) { list.current.scrollTop = restoring.current; restoring.current = null; return }
    if (pendingRound.current) {
      const target = rounds.find(round => round.attempts.some(attempt => attempt.runId === pendingRound.current))
      const round = target ? list.current.querySelector<HTMLElement>(`[data-round-id="${CSS.escape(target.id)}"]`) : null
      if (round) { round.scrollIntoView({ block: 'start' }); pendingRound.current = null; return }
      if (source.isFetching || !source.data) return
      pendingRound.current = null
    }
    if (pendingRow.current) { list.current.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(pendingRow.current)}"]`)?.scrollIntoView({ block: 'nearest' }); pendingRow.current = null; return }
    if (prepending.current && now > prepending.current.updatedAt && !source.isFetchingPreviousPage) {
      list.current.scrollTop = prepending.current.top + list.current.scrollHeight - prepending.current.height; prepending.current = null; return
    }
    if (!search && !errors && (pendingLatest.current || following && (active || followCompletion || appended || source.hasNextPage))) {
      list.current.scrollTop = list.current.scrollHeight
      if (!source.hasNextPage && !source.isFetchingNextPage) pendingLatest.current = false
    }
  }, [visible, groups, following, active, search, errors, now, source.isFetchingPreviousPage, source.hasNextPage])
  useLayoutEffect(() => {
    if (!list.current || !visible) return
    const element = list.current, measure = () => setAtEnd(element.scrollHeight - element.scrollTop - element.clientHeight < 40)
    measure(); const observer = new ResizeObserver(measure); observer.observe(element)
    return () => observer.disconnect()
  }, [visible, groups, selectedItem])
  const moveMatch = (direction: number) => {
    if (!matches.length) return
    const index = matches.findIndex(item => item.key === selected), next = matches[index < 0 ? direction < 0 ? matches.length - 1 : 0 : (index + direction + matches.length) % matches.length]!
    select(next.round, next.entry)
  }
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'f') { event.preventDefault(); searchInput.current?.focus(); return }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !(event.target instanceof HTMLButtonElement) || !event.target.classList.contains('trajectory-row-main')) return
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('.trajectory-row-main') ?? [])], index = buttons.indexOf(event.target)
    event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }
  const chooseAttempt = (round: TrajectoryRound, id: string | null) => { setSelected(null); setScope(null); setFollowing(false); locations.current.clear(); setAttemptChoices(current => { const next = { ...current }; if (id) next[round.id] = id; else delete next[round.id]; return next }) }
  const toggleDeleted = () => { setDeleted(!deleted); setScope(null); setSelected(null); setAttemptChoices({}); setFollowing(false); locations.current.clear() }
  const clearFilters = () => { setQueryText(''); setSearch(''); setErrors(false) }
  const agentKeys = rounds.flatMap(round => round.trajectory.agents.map(agent => traceKey(round.trajectory.run.id, agent.id)))
  return <section className="trajectory-workspace" aria-label={uiT('运行轨迹')} onKeyDown={keyboard}>
    <div className="trajectory-toolbar">
      <Button tone="quiet" className="trajectory-duration-toggle" aria-pressed={actual} onClick={() => setActual(!actual)}><Clock3 size={14} />{uiT(actual ? '实际耗时' : '按步骤')}</Button>
      <Button tone="quiet" aria-pressed={errors} onClick={() => { setErrors(!errors); setFollowing(false) }}><Filter size={14} /><span>{uiT('仅异常')}</span>{failures > 0 && <small className="trajectory-error-count">{failures}</small>}</Button>
      <div className="trajectory-search"><Search size={14} /><Input ref={searchInput} aria-label={uiT('搜索轨迹')} placeholder={uiT('搜索输入、输出、工具…')} maxLength={300} value={queryText} onChange={event => { setQueryText(event.target.value); setFollowing(false); prepending.current = null; pendingLatest.current = false }} />{queryText && <IconButton label={uiT('清除搜索')} onClick={() => { setQueryText(''); setSearch('') }}><X size={13} /></IconButton>}</div>
      {search && <div className="trajectory-match-controls"><span aria-live="polite">{Math.max(0, matches.findIndex(item => item.key === selected) + 1)}/{matches.length}</span><IconButton label={uiT('上一个匹配')} disabled={!matches.length} onClick={() => moveMatch(-1)}><ChevronUp size={14} /></IconButton><IconButton label={uiT('下一个匹配')} disabled={!matches.length} onClick={() => moveMatch(1)}><ChevronDown size={14} /></IconButton></div>}
      <Menu label={uiT('轨迹操作')}><MenuItem disabled={!source.deletedRounds && !deleted} onSelect={toggleDeleted}>{uiT(deleted ? '隐藏已删除轮次' : '查看已删除轮次 (%{count})', { count: source.deletedRounds })}</MenuItem><MenuItem onSelect={() => { setExpanded(new Set(agentKeys)); setCollapsedMatches(new Set()) }}><ChevronsUpDown size={14} />{uiT('展开全部子代理')}</MenuItem><MenuItem onSelect={() => { setExpanded(new Set()); setCollapsedMatches(new Set(agentKeys)) }}>{uiT('收起全部子代理')}</MenuItem><MenuItem onSelect={returnToConversation}><ArrowLeft size={14} />{uiT('返回对话')}</MenuItem><MenuItem asChild><a href={`/api/stories/${story.id}/export`}><Download size={14} />{uiT('导出会话日志')}</a></MenuItem></Menu>
    </div>
    <ErrorNotice error={source.error} retry={() => void source.refetch()} retrying={source.isFetching} />
    {source.isPending ? <Loading /> : !source.data ? null : !source.totalItems ? <Empty title={uiT(source.deletedRounds ? '当前对话没有有效轨迹' : '发送第一条消息后可查看运行轨迹')} action={source.deletedRounds ? <Button tone="quiet" onClick={toggleDeleted}>{uiT('查看已删除轮次 (%{count})', { count: source.deletedRounds })}</Button> : undefined} /> : <>
      <div className="trajectory-summary"><nav aria-label={uiT('代理轨迹导航')}><button type="button" onClick={() => enter(null)} aria-current={!scope ? 'page' : undefined}>{uiT('会话轨迹')}</button>{parentRound && <><span><ChevronRight size={12} />{uiT('第 %{round} 轮', { round: parentRound.round })}</span>{agentPath(parentRound.trajectory, scope!.id).map(agent => <span key={agent.id}><ChevronRight size={12} /><button type="button" onClick={() => enter({ runId: parentRound.trajectory.run.id, id: agent.id })} aria-current={scope!.id === agent.id ? 'page' : undefined}>{agent.name}</button></span>)}</>}</nav>
        {!scope && <span>{uiT('共 %{count} 轮', { count: totalRounds })}{deleted && ` · ${uiT('已删除 %{count} 轮', { count: source.deletedRounds })}`}{rounds.length < source.totalItems && ` · ${uiT('已加载 %{loaded} / %{total} 组', { loaded: rounds.length, total: source.totalItems })}`}</span>}<span>{uiT('%{count} 次模型请求', { count: stats.count })}</span><span>{uiT('%{count} 次工具调用', { count: toolCount })}</span><span className="trajectory-usage" title={uiT('已记录 %{measured} / %{total} 次请求用量', { measured: stats.measured, total: stats.count })}>{stats.measured ? `↑ ${stats.input?.toLocaleString(uiLocale())} / ↓ ${stats.output?.toLocaleString(uiLocale())} tokens${stats.measured < stats.count ? ' *' : ''}` : uiT('用量未记录')}</span>
      </div>
      {parent?.task && <p className="trajectory-task-excerpt">{parent.task}</p>}
      {deleted && <div className="trajectory-history-mode"><span>{uiT('已包含删除记录；标记为已删除的内容不参与当前对话。')}</span><Button tone="quiet" onClick={toggleDeleted}>{uiT('隐藏已删除轮次')}</Button></div>}
      <TraceTimeline rounds={scopedRounds} scope={scope?.id} actual={actual} selected={selected} select={(round, entry) => { clearFilters(); select(round, entry) }} now={now} />
      <div className="trajectory-split" ref={split} data-detail={!!selectedItem || undefined} style={{ '--trace-detail-width': `${detailWidth}%` } as CSSProperties}>
        <div className="trajectory-list" ref={list} role="region" aria-label={uiT('执行事件列表')} tabIndex={0} onScroll={() => { const node = list.current; if (node) { const end = node.scrollHeight - node.scrollTop - node.clientHeight < 40; setFollowing(end); setAtEnd(end) } }}>
          <div className="trajectory-list-heading"><span>{parent?.name ?? uiT('全部轮次')}</span><span>{uiT('%{count} 条记录', { count: groups.reduce((sum, group) => sum + group.rows.length, 0) })}{(search || errors) && <small> · {uiT(source.isError ? '搜索未完成' : source.searching ? '正在搜索全部轮次…' : scope ? '搜索覆盖当前代理及其子代理' : '搜索覆盖当前展示的尝试及子代理')}</small>}</span><span>{uiT('状态 / 耗时')}</span></div>
          {!scope && source.hasPreviousPage && <div className="trajectory-page-control"><Button tone="quiet" disabled={source.isFetching} onClick={loadOlder}><ChevronUp size={14} />{uiT(source.isFetchingPreviousPage ? '正在读取…' : '加载更早的轮次')}</Button></div>}
          {groups.map(({ round, rows }) => <RoundLedger key={round.id} round={round} now={now} viewingAttempt={history.states.get(round.id)?.attempt.attempt} loading={history.states.get(round.id)?.isPending} error={history.states.get(round.id)?.error} retry={() => void history.states.get(round.id)?.refetch()} chooseAttempt={id => chooseAttempt(round, id)}>{rows.map(({ entry, depth }, index) => {
            const data = round.trajectory, key = traceKey(data.run.id, entry.id), agent = data.agents.find(agent => agent.entryId === entry.id), agentKey = agent ? traceKey(data.run.id, agent.id) : ''
            return <Fragment key={key}>{entry.history && !rows.slice(0, index).some(row => row.entry.history && row.entry.agentId === entry.agentId) && <div className="trajectory-preset-heading" style={{ paddingLeft: `${14 + depth * 18}px` }}>{uiT("Writer 预置历史")}<span>{uiT("注入的输入 · 不计为实际调用")}</span></div>}<LedgerEntry rowId={key} entry={entry} agent={agent} depth={depth} selected={selected === key} expanded={!!agent && (search || errors ? !collapsedMatches.has(agentKey) : expanded.has(agentKey))} matched={data.matches.includes(entry.id)} search={search} select={() => select(round, entry)} toggle={() => { if (agent) (search || errors ? setCollapsedMatches : setExpanded)(current => { const next = new Set(current); next.has(agentKey) ? next.delete(agentKey) : next.add(agentKey); return next }) }} enter={() => { if (agent) enter({ runId: data.run.id, id: agent.id }) }} /></Fragment>
          })}{!rows.length && <p className="trajectory-round-empty">{uiT(search || errors ? '没有匹配的记录' : isActive(round.trajectory.run.status) ? '等待第一条执行记录' : '这轮没有逐次执行记录')}</p>}</RoundLedger>)}
          {!groups.length && !source.searching && !source.isError && <Empty title={uiT('没有匹配的记录')} action={<Button tone="quiet" onClick={clearFilters}>{uiT('清除筛选')}</Button>} />}
          {!scope && source.hasNextPage && <div className="trajectory-page-control"><Button tone="quiet" disabled={source.isFetching} onClick={() => void source.fetchNextPage()}><ChevronDown size={14} />{uiT(source.isFetchingNextPage ? '正在读取…' : '加载后续轮次')}</Button></div>}
          <div className="trajectory-list-end" role="status">{uiT(source.isError ? '部分记录未能加载，请重试。' : source.searching ? '正在搜索全部轮次…' : active ? '运行中，记录会自动更新' : !scope && source.hasNextPage ? '还有后续轮次' : scope ? '本次执行记录结束' : '已显示至最新一轮')}</div>
        </div>
        {(!atEnd || !scope && source.hasNextPage) && <Button tone="quiet" className="trajectory-follow" onClick={jump}><ArrowDown size={13} />{uiT('回到最新')}</Button>}
        {selectedItem && <><div className="trajectory-resize" role="separator" aria-label={uiT('调整详情宽度')} aria-orientation="vertical" aria-valuenow={detailWidth} aria-valuemin={30} aria-valuemax={70} tabIndex={0} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setDetailWidth(value => Math.max(30, Math.min(70, value + (event.key === 'ArrowLeft' ? 3 : -3)))) } }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && split.current) { const rect = split.current.getBoundingClientRect(); setDetailWidth(Math.max(30, Math.min(70, (rect.right - event.clientX) / rect.width * 100))) } }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
          <TraceDetails key={selectedItem.key} entry={selectedItem.entry} runId={selectedItem.round.trajectory.run.id} storyId={story.id} round={selectedItem.round.round} attempt={history.states.get(selectedItem.round.id)?.attempt.attempt ?? selectedItem.round.attempts.length} request={selectedItem.entry.detail.type === 'request' ? selectedItem.round.trajectory.requests.find(request => request.id === (selectedItem.entry.detail.type === 'request' ? selectedItem.entry.detail.requestId : '')) : undefined} close={closeDetail} search={search} /></>}
      </div>
    </>}
  </section>
}
