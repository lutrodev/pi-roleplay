import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { RunJournal } from '../apps/server/src/runtime/journal.ts'
import { TraceService } from '../apps/server/src/services/trace-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { fixture, message, profile } from './helpers.ts'
import { ledgerRows, descendantIds, usageTotals, timelinePositions } from '../apps/web/src/pages/story/trajectory/model.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
function setup() {
  const x = fixture(); cleanup.push(x.close)
  const story = x.stories.create('轨迹验收', profile()), service = new StoryService(x.stories, x.assets, x.files)
  const { run } = service.send(story.id, 'trace-test', [{ text: '去灯塔核对记录。', attachmentIds: [] }])
  x.stories.setRunStatus(run.id, 'running')
  const journal = new RunJournal(x.stories, x.files, run), trace = new TraceService(x.stories)
  return { ...x, run, story, journal, trace }
}
it('pairs exact request/response records, searches payloads literally, and preserves nested tool timing without returning full prompts in the list', () => {
  const x = setup(), id = randomUUID(), parent = x.journal.callId('writer')
  x.stories.append(x.story.id, { type: 'tool.started', data: { callId: parent, runId: x.run.id, name: 'rp_write_turn', arguments: {}, status: 'running' } })
  x.journal.model(parent, 'provider:request', { requestId: id, scope: 'writer:writer', parentCallId: parent, provider: 'test', model: 'writer-model', systemPrompt: '唯一系统提示', messages: [{ role: 'user', content: '精确%查询_文本' }] })
  x.journal.model(parent, 'provider:response', { requestId: id, scope: 'writer:writer', parentCallId: parent, elapsedMs: 123, firstTokenMs: 20, response: { stopReason: 'stop', usage: { input: 32, output: 16, cacheRead: 8, cacheWrite: 0, totalTokens: 56 }, content: [{ type: 'text', text: '到达灯塔。' }] } })
  x.stories.append(x.story.id, { type: 'tool.finished', data: { callId: parent, result: { text: '到达灯塔。' }, failed: false } })
  x.stories.setRunStatus(x.run.id, 'completed')
  const trace = x.trace.run(x.run.id, '%查询_')
  expect(trace.requests).toMatchObject([{ id, parentCallId: parent, status: 'completed', elapsedMs: 123, firstTokenMs: 20, usage: { input: 32, output: 16 } }])
  expect(trace.matches).toEqual([id]); expect(trace.tools[0]?.elapsedMs).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(trace)).not.toContain('唯一系统提示')
  expect(JSON.stringify(x.trace.request(x.run.id, id))).toContain('唯一系统提示')
  expect(x.trace.run(x.run.id, '不存在').matches).toEqual([])
  expect(x.trace.logs(x.story.id, 0, 20, '%查询_').records).toHaveLength(1)
  expect(() => x.trace.request(x.run.id, 'missing')).toThrow('不存在')
})
it('paginates metadata, returns explicit event details, and freezes the JSONL export boundary before later edits', async () => {
  const x = setup()
  const first = x.trace.logs(x.story.id, 0, 1, '')
  expect(first.records).toHaveLength(1); expect(first.nextCursor).toBe(first.records[0]!.seq)
  expect(x.trace.event(x.story.id, first.records[0]!.seq).type).toBe('story.created')
  const exported = x.trace.export(x.story.id), expected = x.stories.eventLog(x.story.id)
  x.stories.append(x.story.id, { type: 'message.added', data: { message: message('assistant', '导出开始后的消息') } })
  let text = ''; for await (const chunk of exported.stream) text += String(chunk)
  const lines = text.trim().split('\n').map(line => JSON.parse(line))
  expect(lines[0]).toMatchObject({ format: 'pi-roleplay-event-log', version: 1, throughSequence: expected.at(-1)!.seq })
  expect(lines.slice(1)).toEqual(expected)
  expect(text).not.toContain('导出开始后的消息')
  expect(() => x.trace.event('different-story', first.records[0]!.seq)).toThrow('不存在')
})

it('projects a readable event ledger with nested agents, failure ancestry, lazy payloads and stable search', () => {
  const x = setup(), writer = x.journal.callId('writer'), child = x.journal.callId('review', 'writer:writer')
  x.stories.append(x.story.id, { type: 'tool.started', data: { callId: writer, runId: x.run.id, name: 'rp_write_turn', arguments: { action: 'write' }, status: 'running' } })
  const request = (id: string, owner: string, scope: string, prompt: string, failed = false) => {
    x.journal.model(owner, 'provider:request', { requestId: id, scope, parentCallId: owner, provider: 'test', model: 'trace-model', systemPrompt: '固定系统提示', messages: [{ role: 'user', content: prompt }] })
    x.journal.model(owner, 'provider:response', { requestId: id, scope, parentCallId: owner, elapsedMs: 125, response: { stopReason: failed ? 'error' : 'stop', content: [{ type: 'text', text: failed ? '内部调用失败%_' : '到达灯塔。' }] } })
  }
  request('writer-one', writer, 'writer:writer', 'x'.repeat(3000) + '精确%_搜索')
  x.stories.append(x.story.id, { type: 'tool.started', data: { callId: child, parentCallId: writer, runId: x.run.id, name: 'rp_run_subagent', arguments: { subagent: 'review', task: '核对灯塔资料' }, status: 'running' } })
  x.journal.model(child, 'task:request', { subagentId: 'review', subagentName: '资料校对' })
  request('review-one', child, 'task:review', '核对资料', true)
  request('review-two', child, 'task:review', '重试核对资料')
  x.stories.append(x.story.id, { type: 'tool.finished', data: { callId: child, result: { text: '核对完成' }, failed: false } })
  x.stories.append(x.story.id, { type: 'tool.finished', data: { callId: writer, result: { content: [{ type: 'text', text: '到达灯塔。' }] }, failed: false } })
  x.stories.setRunStatus(x.run.id, 'completed')
  const data = x.trace.trajectory(x.run.id)
  expect(data.inputPreview).toBe('去灯塔核对记录。')
  expect(data.agents).toMatchObject([{ id: writer, parentId: 'main', name: 'Writer', requestCount: 3, errorCount: 1, status: 'completed' }, { id: child, parentId: writer, name: '资料校对', requestCount: 2, errorCount: 1 }])
  expect(data.entries.some(entry => entry.kind === 'system')).toBe(true)
  expect(data.entries.some(entry => entry.kind === 'context')).toBe(true)
  expect(JSON.stringify(data)).not.toContain('x'.repeat(3000))
  expect(ledgerRows(data, 'main', new Set(), false, false).map(row => row.entry.kind)).toEqual(['user', 'tool'])
  expect(ledgerRows(data, 'main', new Set(), false, true).map(row => row.entry.id)).toEqual([`tool:${writer}`, `tool:${child}`, 'request:review-one'])
  expect(ledgerRows(data, 'main', new Set(), false, true, new Set([writer])).map(row => row.entry.id)).toEqual([`tool:${writer}`])
  expect(descendantIds(data, writer)).toEqual(new Set([writer, child]))
  expect(usageTotals(data.requests)).toMatchObject({ count: 3, measured: 0, input: undefined, output: undefined })
  const found = x.trace.trajectory(x.run.id, '精确%_搜索')
  const rows = ledgerRows(found, 'main', new Set(), true, false)
  expect(rows.map(row => row.entry.kind)).toEqual(['tool', 'context'])
  expect(x.trace.trajectory(x.run.id, '不存在').matches).toEqual([])
  expect(x.trace.tool(x.run.id, child).tool.result).toEqual({ text: '核对完成' })
  expect(() => x.trace.tool(x.run.id, 'unrelated-call')).toThrow('不存在')
})

it('counts each measured model invocation once and keeps parallel spans on one wall clock', () => {
  const x = setup(), owner = x.journal.callId('writer'), id = randomUUID()
  x.journal.model(owner, 'provider:request', { requestId: id, scope: 'writer:writer', parentCallId: owner, provider: 'test', model: 'test-model', systemPrompt: '', messages: [] })
  const interrupted = x.trace.trajectory(x.run.id)
  expect(interrupted.agents[0]).toMatchObject({ id: owner, parentId: 'main', status: 'running' })
  expect(ledgerRows(interrupted, 'main', new Set(), false, false).some(row => row.entry.id === `request:${id}`)).toBe(true)
  const request = interrupted.requests[0]!
  expect(usageTotals([request, { ...request, id: 'measured', usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17 } }])).toMatchObject({ count: 2, measured: 1, input: 10, output: 5 })
  const entry = interrupted.entries.find(entry => entry.kind === 'assistant')!
  const start = Date.parse('2026-09-06T10:00:00Z')
  const spans = timelinePositions([{ ...entry, startedAt: new Date(start).toISOString(), elapsedMs: 2000 }, { ...entry, id: 'parallel', startedAt: new Date(start + 500).toISOString(), elapsedMs: 1000 }], true, start + 2000)
  expect(spans.map(span => [span.left, span.width])).toEqual([[0, 100], [25, 50]])
  x.stories.setRunStatus(x.run.id, 'interrupted')
  expect(x.trace.trajectory(x.run.id).entries.find(entry => entry.kind === 'assistant')?.status).toBe('interrupted')
})
