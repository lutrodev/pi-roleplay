import type { StoryEvent } from '../../../../packages/rp-core/src/types.ts'
import type { RunTrace, RunTrajectory, TrajectoryAgent, TrajectoryEntry } from '../../../../packages/protocol/src/trace.ts'
import { losslessObject } from '../runtime/lossless-json.ts'

const PREVIEW_LENGTH = 240
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
function content(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') {
    if (value.startsWith('{')) {
      try { const parsed = object(JSON.parse(value)); if (typeof parsed.text === 'string') return parsed.text; if (parsed.committed === true) return '剧情已提交' } catch { /* Non-JSON text stays literal. */ }
    }
    return value
  }
  if (Array.isArray(value)) return value.map(part => {
    const item = object(part)
    return content(item.text) || text(item.thinking) || (item.type === 'toolCall' ? `${text(item.name)} ${JSON.stringify(item.arguments ?? {})}` : item.type === 'image_reference' ? '[图片]' : '')
  }).filter(Boolean).join('\n')
  const item = object(value)
  return text(item.text) || content(item.content) || (value === undefined ? '' : JSON.stringify(value))
}
const preview = (value: unknown) => content(value).replace(/\s+/g, ' ').slice(0, PREVIEW_LENGTH)
const active = (status: string) => ['running', 'queued', 'waiting_user'].includes(status)

/** Preserve durable event order and call ownership, including failed calls and removed replies. */
export function projectTrajectory(trace: RunTrace, events: Iterable<StoryEvent>, query = ''): RunTrajectory {
  const entries: TrajectoryEntry[] = [], matches: string[] = [], needle = query.toLocaleLowerCase()
  const excerpt = (value: unknown) => {
    const source = content(value).replace(/\s+/g, ' '), index = needle ? source.toLocaleLowerCase().indexOf(needle) : -1
    const start = Math.max(0, index - 50)
    return (start ? '…' : '') + source.slice(start, start + PREVIEW_LENGTH)
  }
  const requests = new Map(trace.requests.map(request => [request.id, request]))
  const models = new Map<string, TrajectoryEntry>(), systems = new Map<string, string>()
  const histories = new Set<string>()
  const agents = new Map<string, TrajectoryAgent>(), tools = new Map(trace.tools.map(tool => [tool.callId, tool]))
  const add = (entry: TrajectoryEntry, searchable: unknown) => {
    entries.push(entry)
    if (!needle || `${entry.title} ${JSON.stringify(searchable)}`.toLocaleLowerCase().includes(needle)) matches.push(entry.id)
  }
  for (const event of events) {
    const { seq, createdAt } = event
    if (event.type === 'message.added' && event.data.message.role === 'user') {
      const message = event.data.message
      add({ id: `event:${seq}`, seq, kind: 'user', agentId: 'main', title: '用户输入', preview: excerpt(message.text) || (message.attachmentIds.length ? '图片与附件' : ''), startedAt: createdAt, detail: { type: 'event', seq } }, message)
    }
    if (event.type === 'model.message' && event.data.role === 'provider:request') {
      const message = event.data.message, requestId = text(message.requestId), request = requests.get(requestId)
      if (!request) continue
      const agentId = request.parentCallId ?? 'main', detail = { type: 'request' as const, requestId }
      const systemPrompt = text(message.systemPrompt)
      if (systemPrompt && systems.get(agentId) !== systemPrompt) {
        add({ id: `system:${seq}`, seq: seq - .9, kind: 'system', agentId, title: systems.has(agentId) ? '系统提示更新' : '系统提示', preview: excerpt(systemPrompt), startedAt: createdAt, detail }, systemPrompt)
        systems.set(agentId, systemPrompt)
      }
      const exact = Array.isArray(message.historyMessagesJson) ? message.historyMessagesJson : []
      const messages = Array.isArray(message.messages) ? message.messages.map((item, index) => typeof exact[index] === 'string' ? losslessObject(exact[index]) : item) : []
      const historyCount = Number(object(message.writerHistory).messageCount)
      if (request.scope.startsWith('writer:') && !histories.has(agentId) && Number.isInteger(historyCount) && historyCount > 0 && historyCount <= messages.length) {
        histories.add(agentId)
        let round = 0
        messages.slice(0, historyCount).forEach((raw, index) => {
          const item = object(raw), role = text(item.role)
          if (role === 'user') round++
          const tool = role === 'toolResult', kind = tool ? 'tool' : role === 'assistant' ? 'assistant' : 'user'
          const previous = object(messages[index - 1]), call = object(Array.isArray(previous.content) ? previous.content[0] : undefined)
          add({ id: `history:${requestId}:${index}`, seq: seq - .8 + index / historyCount * .6, kind, agentId,
            title: tool ? text(item.toolName) : role === 'assistant' ? '预置助手消息' : '预置用户消息',
            preview: tool ? excerpt(call.arguments) : excerpt(item.content), ...(tool ? { resultPreview: excerpt(item.content), status: item.isError === true ? 'failed' as const : 'completed' as const } : {}),
            history: { round }, startedAt: createdAt, detail: { ...detail, messageIndex: index } }, raw)
        })
      }
      const lastInput = messages.findLast(item => object(item).role === 'user')
      const contextText = messages.map(item => content(object(item).content)).join('\n')
      add({ id: `context:${seq}`, seq: seq - .1, kind: 'context', agentId, title: '请求上下文', preview: excerpt(needle ? contextText : object(lastInput).content) || preview(messages), startedAt: createdAt, detail }, message)
      const entry: TrajectoryEntry = { id: `request:${requestId}`, seq, kind: 'assistant', agentId, title: '模型请求', preview: '', model: request.model, startedAt: createdAt, elapsedMs: request.elapsedMs, status: request.status, detail }
      models.set(requestId, entry)
      add(entry, { provider: request.provider, model: request.model, scope: request.scope })
    }
    if (event.type === 'model.message' && event.data.role === 'provider:response') {
      const message = event.data.message, entry = models.get(text(message.requestId)), response = object(message.response)
      if (entry) {
        entry.preview = excerpt(response.content) || text(response.errorMessage)
        if (needle && JSON.stringify(response).toLocaleLowerCase().includes(needle) && !matches.includes(entry.id)) matches.push(entry.id)
      }
    }
    if (event.type === 'tool.started') {
      const tool = tools.get(event.data.callId)
      if (!tool) continue
      const entry: TrajectoryEntry = { id: `tool:${tool.callId}`, seq, kind: 'tool', agentId: tool.parentCallId ?? 'main', title: tool.name, preview: excerpt(tool.arguments), resultPreview: excerpt(tool.result ?? tool.output), startedAt: tool.startedAt ?? createdAt, elapsedMs: tool.elapsedMs, status: tool.status, detail: { type: 'tool', callId: tool.callId } }
      add(entry, tool)
      const children = trace.requests.filter(request => request.parentCallId === tool.callId)
      if (children.length || ['rp_write_turn', 'rp_run_subagent'].includes(tool.name)) {
        agents.set(tool.callId, { id: tool.callId, parentId: entry.agentId, entryId: entry.id,
          name: tool.name === 'rp_write_turn' || children[0]?.scope.startsWith('writer:') ? 'Writer' : text(tool.arguments.subagent) || '任务子代理',
          task: preview(tool.arguments.task ?? tool.arguments.brief ?? tool.arguments.input), status: tool.status,
          startedAt: entry.startedAt, elapsedMs: tool.elapsedMs, requestCount: children.length, errorCount: 0 })
      }
    }
    if (event.type === 'model.message' && event.data.role === 'task:request') {
      const agent = agents.get(event.data.ownerMessageId)
      if (agent && typeof event.data.message.subagentName === 'string') agent.name = event.data.message.subagentName
    }
    if (event.type === 'turn.committed') {
      const { stateUpdates, summary, message } = event.data
      add({ id: `event:${seq}`, seq, kind: 'commit', agentId: 'main', title: '剧情已提交', preview: excerpt(needle ? `${summary}\n${message.text}` : summary || message.text), resultPreview: stateUpdates.length ? `${stateUpdates.length} 个变量组更新` : '', status: 'completed', startedAt: createdAt, detail: { type: 'event', seq } }, event.data)
    }
    if ((event.type === 'context.built' || event.type === 'context.compacted') && !trace.requests.length) {
      add({ id: `event:${seq}`, seq, kind: 'context', agentId: 'main', title: '已记录的上下文', preview: excerpt(event.data.parentPrompt), startedAt: createdAt, detail: { type: 'event', seq } }, event.data)
    }
  }
  // A damaged/incomplete log must still expose a child request rather than silently dropping it.
  for (const entry of entries) if (entry.agentId !== 'main' && !agents.has(entry.agentId)) {
    agents.set(entry.agentId, { id: entry.agentId, parentId: 'main', entryId: '', name: trace.requests.find(request => request.parentCallId === entry.agentId)?.scope.startsWith('writer:') ? 'Writer' : '任务子代理', task: '', status: active(trace.run.status) ? 'running' : 'interrupted', startedAt: entry.startedAt, requestCount: 0, errorCount: 0 })
  }
  for (const agent of agents.values()) {
    const descendants = new Set([agent.id])
    for (let changed = true; changed;) { changed = false; for (const child of agents.values()) if (descendants.has(child.parentId) && !descendants.has(child.id)) { descendants.add(child.id); changed = true } }
    agent.requestCount = trace.requests.filter(request => descendants.has(request.parentCallId ?? 'main')).length
    agent.errorCount = entries.filter(entry => !entry.history && descendants.has(entry.agentId) && ['failed', 'interrupted', 'truncated'].includes(entry.status ?? '')).length
  }
  return { run: trace.run, entries: entries.sort((a, b) => a.seq - b.seq), agents: [...agents.values()], requests: trace.requests, matches, inputPreview: entries.find(entry => entry.kind === 'user')?.preview ?? '' }
}
