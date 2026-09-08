import type { ModelRequestSummary, RunTrajectory, TrajectoryEntry, TrajectoryStatus } from '../../../../../../packages/protocol/src/trace.ts'

export const roleLabels = { system: '系统', user: '用户', context: '上下文', assistant: '助手', tool: '工具', commit: '提交' }
export const statusLabels: Record<TrajectoryStatus, string> = { running: '运行中', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断', truncated: '输出截断', waiting_user: '等待回答', queued: '排队中' }
export const toolLabels: Record<string, string> = { rp_write_turn: '撰写回复', rp_commit_turn: '提交剧情', rp_run_subagent: '调用子代理', rp_asset_read: '读取资料', rp_state_read: '读取变量', rp_state: '修改变量', rp_asset: '修改资料', read: '读取文件', bash: '执行命令', web_search: '搜索网页', skill: '读取技能', ask_user_question: '询问用户' }
export const isActive = (status?: string) => ['running', 'waiting_user', 'queued'].includes(status ?? '')
export const isError = (entry: Pick<TrajectoryEntry, 'status' | 'history'>) => !entry.history && ['failed', 'interrupted', 'truncated'].includes(entry.status ?? '')
export const duration = (ms?: number) => ms === undefined ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} m ${Math.round(ms % 60000 / 1000)} s`

export function descendantIds(data: RunTrajectory, scope: string) {
  const ids = new Set([scope])
  for (let changed = true; changed;) {
    changed = false
    for (const agent of data.agents) if (ids.has(agent.parentId) && !ids.has(agent.id)) { ids.add(agent.id); changed = true }
  }
  return ids
}
export function agentPath(data: RunTrajectory, scope: string) {
  const result = [], seen = new Set<string>()
  let agent = data.agents.find(agent => agent.id === scope)
  while (agent && !seen.has(agent.id)) { result.unshift(agent); seen.add(agent.id); agent = data.agents.find(parent => parent.id === agent!.parentId) }
  return result
}
export interface LedgerRow { entry: TrajectoryEntry; depth: number }
export function ledgerRows(data: RunTrajectory, scope: string, expanded: ReadonlySet<string>, search: boolean, errors: boolean, collapsedMatches: ReadonlySet<string> = new Set()): LedgerRow[] {
  const matchIds = new Set(data.matches), children = new Map(data.agents.map(agent => [agent.entryId, agent]))
  const byAgent = new Map<string, TrajectoryEntry[]>()
  for (const entry of data.entries) { const rows = byAgent.get(entry.agentId) ?? []; rows.push(entry); byAgent.set(entry.agentId, rows) }
  const direct = (entry: TrajectoryEntry) => (!search || matchIds.has(entry.id)) && (!errors || isError(entry))
  const relevant = new Set(data.entries.filter(direct).map(entry => entry.agentId))
  for (const id of [...relevant]) for (const parent of agentPath(data, id)) { relevant.add(parent.id); relevant.add(parent.parentId) }
  const rows: LedgerRow[] = [], visited = new Set<string>()
  function visit(id: string, depth: number) {
    if (visited.has(id)) return
    visited.add(id)
    for (const entry of byAgent.get(id) ?? []) {
      const child = children.get(entry.id), filtered = search || errors
      if (filtered && !direct(entry) && !(child && relevant.has(child.id))) continue
      rows.push({ entry, depth })
      if (child && (filtered ? relevant.has(child.id) && !collapsedMatches.has(child.id) : expanded.has(child.id))) visit(child.id, depth + 1)
    }
    for (const child of data.agents.filter(agent => agent.parentId === id && !agent.entryId)) visit(child.id, depth + 1)
  }
  visit(scope, 0)
  return rows
}

/** Sum leaf model requests once. Missing usage is not a zero-token measurement. */
export function usageTotals(requests: readonly ModelRequestSummary[]) {
  const measured = requests.filter(request => request.usage !== undefined)
  return { count: requests.length, measured: measured.length,
    input: measured.length ? measured.reduce((sum, request) => sum + request.usage!.input, 0) : undefined,
    output: measured.length ? measured.reduce((sum, request) => sum + request.usage!.output, 0) : undefined,
    cacheRead: measured.length ? measured.reduce((sum, request) => sum + request.usage!.cacheRead, 0) : undefined,
    cacheWrite: measured.length ? measured.reduce((sum, request) => sum + request.usage!.cacheWrite, 0) : undefined,
    cost: measured.some(request => request.usage?.cost) ? measured.reduce((sum, request) => sum + (request.usage?.cost?.total ?? 0), 0) : undefined }
}
export function timelinePositions(entries: readonly TrajectoryEntry[], actual: boolean, now: number) {
  const start = Math.min(...entries.map(entry => Date.parse(entry.startedAt))), end = Math.max(...entries.map(entry => Date.parse(entry.startedAt) + (entry.elapsedMs ?? (isActive(entry.status) ? Math.max(0, now - Date.parse(entry.startedAt)) : 0))))
  const span = Math.max(1, end - start)
  return entries.map((entry, index) => ({ entry,
    left: actual ? (Date.parse(entry.startedAt) - start) / span * 100 : index / entries.length * 100,
    width: actual ? Math.max(.35, (entry.elapsedMs ?? (isActive(entry.status) ? now - Date.parse(entry.startedAt) : 0)) / span * 100) : 100 / entries.length,
  }))
}
