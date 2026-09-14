import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { fixture, profile } from './helpers.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TraceService } from '../apps/server/src/services/trace-service.ts'
import { RunJournal } from '../apps/server/src/runtime/journal.ts'
import { beginModelProgress } from '../apps/server/src/runtime/live-progress.ts'
import { SubagentProgress, quietActivity } from '../apps/web/src/pages/story/subagent-progress.tsx'
import { agentStatusLabel } from '../apps/web/src/pages/story/activity-labels.ts'
import { LedgerEntry } from '../apps/web/src/pages/story/trajectory/ledger.tsx'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(close => close()); vi.restoreAllMocks() })
function setup() {
  const x = fixture(); cleanups.push(x.close)
  const story = x.stories.create('协作进展验收', profile())
  const { run } = new StoryService(x.stories, x.assets, x.files).send(story.id, 'collaboration', [{ text: '核对灯塔记录。', attachmentIds: [] }])
  x.stories.setRunStatus(run.id, 'running')
  const journal = new RunJournal(x.stories, x.files, run), trace = new TraceService(x.stories)
  const start = (callId: string, name = 'rp_run_subagent', parentCallId?: string) => {
    x.stories.append(story.id, { type: 'tool.started', data: { callId, runId: run.id, name, ...(parentCallId ? { parentCallId } : {}), arguments: { subagent: 'review', task: '核对灯塔记录。', ...(name === 'read' ? { file_path: 'lighthouse.txt' } : {}) }, status: 'running' } })
    if (name === 'rp_run_subagent') journal.model(callId, 'task:request', { subagentId: 'review', subagentName: '设定检查' })
  }
  const request = (callId: string, id: string, scope = `task:${callId}`) => {
    journal.model(callId, 'provider:request', { requestId: id, scope, parentCallId: callId, provider: 'synthetic', model: 'test-model', systemPrompt: '不能进入进展的提示词', messages: [] })
    const live = beginModelProgress(x.stories, run.id, id); cleanups.push(() => live.close())
    return live
  }
  const respond = (callId: string, id: string, text = '核对完成。', scope = `task:${callId}`) => journal.model(callId, 'provider:response', {
    requestId: id, parentCallId: callId, scope, response: { stopReason: 'stop', content: [{ type: 'thinking', thinking: '不能进入进展的内部思考' }, { type: 'text', text }] },
  })
  const finish = (callId: string, failed = false) => x.stories.append(story.id, { type: 'tool.finished', data: { callId, result: { private: '不能进入进展的完整工具结果' }, failed } })
  return { ...x, story, run, journal, trace, start, request, respond, finish, activity: () => trace.activity(run.id) }
}
const partial: AssistantMessage = { role: 'assistant', provider: 'synthetic', model: 'test-model', api: 'openai-completions', content: [], timestamp: 0, stopReason: 'stop',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }

it('keeps same-name parallel invocations separate and follows each call across model/tool boundaries', () => {
  const x = setup(); x.start('first'); x.start('second')
  const first = x.request('first', 'r1'), second = x.request('second', 'r2')
  first.update({ type: 'text_delta', contentIndex: 0, delta: '正在核对第一份资料。', partial }); second.queued(true)
  expect(x.activity().agents).toMatchObject([
    { callId: 'first', name: '设定检查', status: 'running', phase: 'responding', text: '正在核对第一份资料。' },
    { callId: 'second', name: '设定检查', status: 'running', phase: 'queued', text: '' },
  ])
  x.respond('first', 'r1', '先读取文件。'); first.close(); x.start('read-one', 'read', 'first')
  expect(x.activity().agents[0]).toMatchObject({ status: 'running', phase: 'tools', requestCount: 1, text: '先读取文件。', tools: [{ name: 'read' }] })
  expect(x.activity().agents[1]!.tools).toEqual([])
  x.finish('read-one')
  expect(x.activity().agents[0]).toMatchObject({ status: 'running', phase: 'continuing' })
  const next = x.request('first', 'r3')
  next.update({ type: 'thinking_delta', contentIndex: 0, delta: '不能进入进展的内部思考', partial })
  expect(x.activity().agents[0]).toMatchObject({ status: 'running', phase: 'thinking', requestCount: 2 })
  x.respond('first', 'r3'); next.close()
  expect(x.activity().agents[0]!.status).toBe('running')
  x.finish('first'); expect(x.activity().agents[0]!.status).toBe('completed')
  expect(x.activity().agents[1]!.status).toBe('running')
  expect(JSON.stringify(x.activity())).not.toContain('不能进入进展')
})

it('restores bounded task summaries after refresh/completion without replaying output or copying Writer prose', () => {
  const x = setup(); x.start('task'); x.start('writer', 'rp_write_turn')
  x.request('task', 'r1').close(); x.respond('task', 'r1', '灯🌙'.repeat(400)); x.finish('task')
  x.request('writer', 'w1', 'writer:writer').close(); x.respond('writer', 'w1', 'Writer 正文只出现在草稿与轨迹', 'writer:writer'); x.finish('writer')
  x.stories.append(x.story.id, { type: 'tool.updated', data: { callId: 'task', output: '不能进入进展的大量输出'.repeat(1000) } })
  x.stories.setRunStatus(x.run.id, 'completed')
  vi.spyOn(x.stories, 'toolEvents').mockImplementation(() => { throw new Error('must not replay tools') })
  vi.spyOn(x.stories, 'snapshot').mockImplementation(() => { throw new Error('must not project story') })
  const state = new TraceService(x.stories).activity(x.run.id)
  expect([...state.agents[0]!.text]).toHaveLength(240)
  expect(state.agents[0]!.text).toBe('灯🌙'.repeat(120))
  expect(state.agents[1]!.text).toBe('')
  expect(state.agents.every(agent => agent.finishedAt && agent.status === 'completed')).toBe(true)
  expect(state.live).toEqual([])
  expect(JSON.stringify(state)).not.toContain('不能进入进展')
  expect(JSON.stringify(state)).not.toContain('Writer 正文')
  const html = renderToStaticMarkup(createElement(SubagentProgress, { run: x.stories.run(x.run.id), snapshot: state, synchronized: true, inspect() {} }))
  expect(html).toContain('协作已结束'); expect(html).toContain('data-state="closed"')
})

it.each(['cancelled', 'interrupted', 'failed'] as const)('stops unfinished invocation activity on %s while preserving already completed calls', status => {
  const x = setup(); x.start('done'); x.finish('done'); x.start('pending'); x.request('pending', 'r1')
  x.stories.setRunStatus(x.run.id, status)
  const state = x.activity()
  expect(state.agents[0]!.status).toBe('completed')
  expect(state.agents[1]!.status).toBe(status === 'cancelled' ? 'cancelled' : 'interrupted')
  expect(state.agents[1]!.finishedAt).toBeTruthy(); expect(state.live).toEqual([]); expect(state.tools).toEqual([])
  const html = renderToStaticMarkup(createElement(SubagentProgress, { run: x.stories.run(x.run.id), snapshot: state, synchronized: true, inspect() {} }))
  expect(html).not.toContain('rotate(360deg)')
})

it('retains failed calls and separates an old request from a different story instance', () => {
  const x = setup(), y = setup(); x.start('failed'); x.finish('failed', true); x.start('running'); x.request('running', 'r1')
  expect(y.activity().agents).toEqual([]); expect(y.activity().live).toEqual([])
  expect(x.activity().agents[0]!.status).toBe('failed')
  const html = renderToStaticMarkup(createElement(SubagentProgress, { run: x.stories.run(x.run.id), snapshot: x.activity(), synchronized: true, inspect() {} }))
  expect(html).toContain('设定检查'); expect(html).toContain('失败'); expect(html).toContain('1 项进行中')
  expect(renderToStaticMarkup(createElement(SubagentProgress, { run: y.run, snapshot: x.activity(), synchronized: true, inspect() {} }))).toBe('')
})

it('recognizes durable cancellation errors even between model calls, without hiding earlier failures', () => {
  const x = setup(); x.start('failed'); x.finish('failed', true); x.start('stopped')
  x.request('stopped', 'r1').close(); x.respond('stopped', 'r1')
  x.stories.append(x.story.id, { type: 'tool.finished', data: { callId: 'stopped', failed: true,
    result: { content: [{ type: 'text', text: JSON.stringify({ code: 'RUN_CANCELLED', message: '已停止生成。' }) }], details: {} } } })
  x.stories.setRunStatus(x.run.id, 'cancelled')
  expect(x.activity().agents.map(agent => agent.status)).toEqual(['failed', 'cancelled'])
  expect(agentStatusLabel(x.activity().agents[1]!)).toBe('已停止')
})

it('renders live text/queue stages in the model ledger and reports inactivity from actual updates', () => {
  const x = setup(); x.start('task'); const current = x.request('task', 'r1'); current.queued(true)
  const agent = x.activity().agents[0]!, start = Date.parse(agent.updatedAt)
  expect(agentStatusLabel(agent)).toBe('等待模型名额'); expect(quietActivity(agent, start + 60_000)).toBe(false)
  expect(quietActivity({ ...agent, phase: 'thinking' }, start + 29_999)).toBe(false)
  expect(quietActivity({ ...agent, phase: 'thinking' }, start + 30_000)).toBe(true)
  current.update({ type: 'text_delta', contentIndex: 0, delta: '正在逐条核对。', partial })
  const entry = x.trace.trajectory(x.run.id).entries.find(entry => entry.id === 'request:r1')!
  const html = renderToStaticMarkup(createElement(LedgerEntry, { entry, activity: x.activity().live[0], depth: 0, selected: false, expanded: false, matched: false, search: '', select() {}, toggle() {}, enter() {} }))
  expect(html).toContain('正在逐条核对。'); expect(html).toContain('正在生成结果'); expect(html).not.toContain('正在等待返回')
})
