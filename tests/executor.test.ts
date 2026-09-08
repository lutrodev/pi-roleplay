import { afterEach, describe, expect, it } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { RunExecutor, type ExecutionResources } from '../apps/server/src/runtime/executor.ts'
import { ModelRegistry, type ModelRegistration } from '../apps/server/src/runtime/models.ts'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import type { ExecutionMode, StoryState } from '../packages/rp-core/src/types.ts'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import { fixture, profile } from './helpers.ts'
import { streamingTextResponse } from './streaming-response.ts'
import { WriterHistoryService } from '../apps/server/src/services/writer-history-service.ts'
import { TraceService } from '../apps/server/src/services/trace-service.ts'
import { historyConfig } from './writer-history-fixture.ts'
import { readingView, storyNotice } from '../packages/protocol/src/reading.ts'
import { ModelHistoryService } from '../apps/server/src/services/model-history-service.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(item => item.close()))
const registration: ModelRegistration = { provider: 'test', model: 'roleplay', keyEnv: 'TEST_RP_KEY', api: 'openai-completions', baseUrl: 'https://model.test/v1', contextWindow: 100_000, maxTokens: 8000 }
const route = { provider: 'test', model: 'roleplay' }
const emptyResources = (): ExecutionResources => ({ routes: { main: route, writer: route }, files: [], images: [], readonlyTools: [], specialists: [], tools: () => [] })
type ScriptedReply = { text?: string; calls?: { name: string; args: object }[]; finish?: string }

function response(reply: ScriptedReply, index: number) {
  const delta = { role: 'assistant', ...(reply.text ? { content: reply.text } : {}), ...(reply.calls ? { tool_calls: reply.calls.map((call, order) => ({ index: order, id: `call-${index}-${order}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) }
  return new Response('data: ' + JSON.stringify({ id: `answer-${index}`, choices: [{ index: 0, delta, finish_reason: reply.finish ?? (reply.calls ? 'tool_calls' : 'stop') }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}
function setup(replies: (ScriptedReply | ((signal?: AbortSignal | null) => Response))[], mode: ExecutionMode = 'chat', state?: StoryState) {
  const x = fixture(); fixtures.push(x)
  const config = profile(); config.runtime.executionMode = mode
  const story = x.stories.create('灯塔', config, state)
  const service = new StoryService(x.stories, x.assets, x.files)
  const requests: Record<string, unknown>[] = []
  const registry = new ModelRegistry([registration], { env: () => 'test-key', fetch: async (_url, init) => {
    const index = requests.length
    requests.push(JSON.parse(String(init?.body)))
    const next = replies[index]
    if (!next) throw new Error(`Unexpected model call ${index}`)
    return typeof next === 'function' ? next(init?.signal) : response(next, index)
  } })
  const executor = new RunExecutor(x.stories, new ContextService(x.stories, x.assets), new TurnService(x.stories), registry, x.files)
  const resources = emptyResources()
  const faults: unknown[] = []
  const queue = new RunQueue(x.stories, (id, signal) => executor.execute(id, signal, resources), error => faults.push(error))
  const run = service.send(story.id, 'message-1', [{ text: '走进灯塔。', attachmentIds: [] }]).run
  return { ...x, story, service, requests, executor, resources, queue, run, faults }
}
const write = { name: 'rp_write_turn', args: { action: 'write' } }
const commit = { name: 'rp_commit_turn', args: { runSummary: '进入灯塔。' } }
const writerReply = { name: 'rp_reply', args: { useWriterResult: true } }
const unchangedState = (): StoryState => ({ namespaces: { story: createNamespaceSnapshot({ initialValue: { minute: 5 }, definition: {
  title: '场景时间', updateMode: 'schema-only', rules: [], schema: { type: 'object', properties: { minute: { type: 'integer' } }, required: ['minute'], additionalProperties: false },
} }) } })

describe('Writer result routing', () => {
  it.each(['chat', 'agent'] as const)('delivers the saved non-narrative %s response exactly once without effects or generated options', async mode => {
    const text = '这次请求无法继续。请换一个方向，或补充需要澄清的信息。'
    const state = unchangedState(), x = setup([{ calls: [write] }, { text }, { calls: [writerReply, commit] }], mode, state)
    let options = 0
    x.resources.replyOptions = async () => { options++; return { extensions: {}, diagnostics: [] } }
    x.queue.wake(); await x.queue.idle()
    const story = x.stories.snapshot(x.story.id), events = x.stories.eventLog(x.story.id)
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(story.messages.filter(message => message.kind !== 'tool').map(message => [message.kind, message.text])).toEqual([['message', '走进灯塔。'], ['message', text]])
    expect(story.state).toEqual(state)
    expect(events.some(event => event.type === 'turn.committed')).toBe(false)
    expect(story.tools.filter(tool => tool.name === 'rp_write_turn')).toHaveLength(1)
    expect(story.tools.find(tool => tool.name === 'rp_commit_turn')?.status).toBe('failed')
    expect(options).toBe(0)
    expect(x.requests).toHaveLength(3)
    expect(JSON.stringify(new ModelHistoryService(x.stories).read(story))).toContain(text)
    expect(x.faults).toEqual([])
  })

  it('requires the parent to read Writer before selecting the non-narrative exit', async () => {
    const x = setup([{ calls: [write, writerReply] }, { text: '请先确认故事发生的地点。' }, { calls: [writerReply] }])
    x.queue.wake(); await x.queue.idle()
    const story = x.stories.snapshot(x.story.id)
    expect(story.tools.filter(tool => tool.name === 'rp_reply').map(tool => tool.status)).toEqual(['failed', 'completed'])
    expect(JSON.stringify(story.tools.find(tool => tool.name === 'rp_reply')?.result)).toContain('WRITER_REVIEW_REQUIRED')
    expect(story.messages.at(-1)).toMatchObject({ kind: 'message', text: '请先确认故事发生的地点。' })
    expect(x.stories.hasCommitted(x.run.id)).toBe(false)
    expect(x.requests).toHaveLength(3)
  })

  it('rejects reuse before Writer and does not accept replacement text alongside reuse', async () => {
    const x = setup([{ calls: [writerReply] }, { calls: [write] }, { text: '需要补充信息才能继续。' },
      { calls: [{ name: 'rp_reply', args: { useWriterResult: true, text: '擅自替换的正文。' } }] }, { calls: [writerReply] }])
    x.queue.wake(); await x.queue.idle()
    const story = x.stories.snapshot(x.story.id)
    expect(story.tools.filter(tool => tool.name === 'rp_reply').map(tool => tool.status)).toEqual(['failed', 'failed', 'completed'])
    expect(story.messages.at(-1)).toMatchObject({ kind: 'message', text: '需要补充信息才能继续。' })
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(x.stories.hasCommitted(x.run.id)).toBe(false)
  })

  it('preserves the single successful Writer guard while allowing a non-narrative finish after the rejected duplicate', async () => {
    const x = setup([{ calls: [write] }, { text: '需要先澄清人物之间的关系。' }, { calls: [write] }, { calls: [writerReply] }])
    x.queue.wake(); await x.queue.idle()
    const story = x.stories.snapshot(x.story.id)
    expect(story.tools.filter(tool => tool.name === 'rp_write_turn').map(tool => tool.status)).toEqual(['completed', 'failed'])
    expect(JSON.stringify(story.tools.filter(tool => tool.name === 'rp_write_turn')[1]?.result)).toContain('WRITER_ALREADY_COMPLETED')
    expect(story.messages.at(-1)?.kind).toBe('message')
    expect(x.requests).toHaveLength(4)
    expect(x.stories.eventLog(x.story.id).filter(event => event.type === 'writer.completed')).toHaveLength(1)
  })

  it('offers both valid completion paths when repairing an unfinalized Chat response after Writer', async () => {
    const x = setup([{ calls: [write] }, { text: '请确认使用哪个视角。' }, { text: '需要用户先确认。' }, { calls: [writerReply] }])
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(JSON.stringify(x.requests[3]?.messages)).toContain('useWriterResult:true')
    expect(x.stories.snapshot(x.story.id).messages.at(-1)).toMatchObject({ kind: 'message', text: '请确认使用哪个视角。' })
  })

  it.each(['chat', 'agent'] as const)('stops an explicitly filtered Writer request in %s without a parent retry or a commit', async mode => {
    const state = unchangedState(), x = setup([{ calls: [write] }, { text: '未完成的回复', finish: 'content_filter' }], mode, state)
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id)).toMatchObject({ status: 'failed', error: { code: 'MODEL_CONTENT_FILTER' } })
    expect(x.requests).toHaveLength(2)
    expect(x.stories.snapshot(x.story.id).state).toEqual(state)
    expect(x.stories.eventLog(x.story.id).some(event => ['writer.completed', 'turn.committed'].includes(event.type))).toBe(false)
  })

  it.each(['chat', 'agent'] as const)('repairs empty state changes in %s by omitting effects, without fabricating an update', async mode => {
    const state = unchangedState(), prose = '两人静静等待，场景没有变化。'
    const args = mode === 'agent' ? { narrative: prose } : {}
    const x = setup([{ calls: [write] }, { text: prose }, { calls: [{ name: 'rp_commit_turn', args: { ...args,
      effects: [{ kind: 'state.update', namespace: 'story', expectedRevision: 1, payload: { changes: [] } }],
    } }] }, { calls: [{ name: 'rp_commit_turn', args: { ...args, effects: [] } }] }], mode, state)
    x.queue.wake(); await x.queue.idle()
    const story = x.stories.snapshot(x.story.id)
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(story.state).toEqual(state)
    expect(story.tools.filter(tool => tool.name === 'rp_commit_turn').map(tool => tool.status)).toEqual(['failed', 'completed'])
    expect(story.messages.at(-1)).toMatchObject({ kind: 'narrative', text: prose })
    expect(x.stories.eventLog(x.story.id).find(event => event.type === 'turn.committed')).toMatchObject({ data: { stateUpdates: [], effects: [] } })
  })
})

it.each(['chat', 'agent'] as const)('freezes native Writer history through retries in %s, never injects into the parent, and audits correct trajectory order', async mode => {
  const prose = '新的正文，与预置回复不同。'
  const x = setup([{ calls: [write] }, () => {
    const config = historyConfig(); config.rounds[0]!.user = '下轮才应出现的新历史'
    history.update(2, config)
    return new Response('{"error":{"message":"synthetic first Writer failure"}}', { status: 400 })
  }, { calls: [write] }, { text: prose }, { calls: [{ name: 'rp_commit_turn', args: mode === 'agent' ? { narrative: prose } : {} }] }], mode)
  const history = new WriterHistoryService(x.assets)
  history.update(1, historyConfig()); x.resources.writerHistory = history.capture()
  x.queue.wake(); await x.queue.idle()
  expect(x.stories.run(x.run.id).status).toBe('completed')
  expect(x.requests).toHaveLength(5)
  expect((x.requests[1]!.messages as object[]).slice(1, 11)).toEqual((x.requests[3]!.messages as object[]).slice(1, 11))
  for (const index of [0, 2, 4]) expect(JSON.stringify(x.requests[index])).not.toContain('900719925474099312345')
  expect(JSON.stringify(x.requests)).not.toContain('下轮才应出现的新历史')
  const events = x.stories.eventLog(x.story.id)
  const written = events.find(event => event.type === 'writer.completed')
  expect(written).toMatchObject({ data: { text: prose, writerHistory: { revision: 2, messageCount: 10, toolCallCount: 3 } } })
  expect(events.filter(event => event.type === 'tool.started').map(event => event.data.name)).toEqual(['rp_write_turn', 'rp_write_turn', 'rp_commit_turn'])
  expect(events.some(event => event.type === 'model.message' && event.data.role === 'runtime:writer-history')).toBe(true)
  const trace = new TraceService(x.stories), trajectory = trace.trajectory(x.run.id)
  expect(trajectory.agents).toHaveLength(2)
  for (const agent of trajectory.agents) {
    const rows = trajectory.entries.filter(entry => entry.agentId === agent.id)
    expect(rows.map(entry => entry.kind)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant', 'context', 'assistant'])
    expect(rows.filter(entry => entry.history).map(entry => entry.history!.round)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2])
    expect(rows[4]!.preview).toContain('900719925474099312345')
    expect(rows[5]!.preview).toContain('900719925474099312345')
    expect(rows[5]!.resultPreview).toContain('900719925474099312345')
    expect(agent.errorCount).toBe(agent.status === 'failed' ? 1 : 0)
    const request = trajectory.requests.find(item => item.parentCallId === agent.id)!
    expect(JSON.stringify(trace.request(x.run.id, request.id))).toContain('900719925474099312345')
  }
  expect(trajectory.requests).toHaveLength(5)
  await x.queue.close()
})

describe('real Pi loop with durable RP tools', () => {
  it.each(['chat', 'agent'] as const)('keeps parent introductions and review text out of every live %s draft and reading snapshot', async mode => {
    const before = '我先检查设定，再安排写作。', after = '我已审阅，接下来提交。'
    const prose = '灯塔的门开了，海风翻动桌上的信。', final = mode === 'agent' ? '灯塔的门开了，桌上的信被海风翻起一角。' : prose
    const x = setup([{ text: before, calls: [write] }, { text: prose }, { text: after, calls: [{ ...commit, args: mode === 'agent' ? { narrative: final } : {} }] }], mode)
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    const events = x.stories.eventLog(x.story.id), drafts = events.filter(event => event.type === 'run.draft')
    expect(drafts[0]?.data.text).toBe(prose)
    const live = JSON.stringify(drafts.map(storyNotice)), visible = JSON.stringify(readingView(x.stories.snapshot(x.story.id)))
    for (const commentary of [before, after]) {
      expect(live).not.toContain(commentary)
      expect(visible).not.toContain(commentary)
      expect(JSON.stringify(events.filter(event => event.type === 'model.message'))).toContain(commentary)
    }
    expect(x.stories.run(x.run.id).draft).toBe(final)
    expect(x.stories.snapshot(x.story.id).messages.filter(message => message.kind === 'narrative')).toEqual([expect.objectContaining({ text: final })])
  })

  it.each(['chat', 'agent'] as const)('retains streamed Writer prose when %s is stopped without starting another model request', async mode => {
    const text = '海风吹过灯塔。她打开那封信，读起寄信人留下的话。\n\n门外忽然传来脚步声，灯光映出一位迟来的客人。'
    const x = setup([{ calls: [write] }, signal => streamingTextResponse(text, signal)], mode)
    x.queue.wake()
    try {
      await expect.poll(() => x.stories.run(x.run.id).draft.length, { timeout: 4000 }).toBeGreaterThanOrEqual(28)
      const received = x.stories.run(x.run.id).draft
      expect(text.startsWith(received)).toBe(true)
      expect(received.length).toBeLessThan(text.length)
      await x.queue.cancel(x.run.id); await x.queue.idle()
      const run = x.stories.run(x.run.id), story = x.stories.snapshot(x.story.id)
      expect(run.status).toBe('cancelled')
      expect(run.draft.startsWith(received)).toBe(true)
      expect(story.messages.filter(message => message.kind === 'draft')).toEqual([expect.objectContaining({ text: run.draft })])
      expect(x.stories.hasCommitted(run.id)).toBe(false)
      expect(x.requests).toHaveLength(2)
      expect(x.faults).toEqual([])
    } finally { await x.queue.close() }
  })

  it('flushes the final partial Writer text even when it arrives inside the draft throttle window', async () => {
    const x = setup([{ calls: [write] }, { text: '已接收但尚未完成的正文。', finish: 'length' }])
    const config = x.stories.snapshot(x.story.id).profile; config.runtime.maxSteps = 1
    x.stories.append(x.story.id, { type: 'profile.changed', data: { profile: config } })
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id)).toMatchObject({ status: 'failed', draft: '已接收但尚未完成的正文。' })
    expect(x.stories.snapshot(x.story.id).messages.filter(message => message.kind === 'draft')).toEqual([expect.objectContaining({ text: '已接收但尚未完成的正文。' })])
    expect(x.stories.hasCommitted(x.run.id)).toBe(false)
  })

  it('reports provider content filtering distinctly, without retrying or committing an incomplete response', async () => {
    const x = setup([{ text: '未完成的回复', finish: 'content_filter' }])
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id)).toMatchObject({ status: 'failed', error: { code: 'MODEL_CONTENT_FILTER' } })
    expect(x.stories.hasCommitted(x.run.id)).toBe(false)
    expect(x.requests).toHaveLength(1)
    expect(x.stories.snapshot(x.story.id).messages[0]?.role).toBe('user')
  })

  it('runs the fresh Writer, commits its exact Chat text, and stops without an extra provider call', async () => {
    const x = setup([{ calls: [write] }, { text: '门内传来潮水的回声。' }, { calls: [commit] }])
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(x.requests).toHaveLength(3)
    const snapshot = x.stories.snapshot(x.story.id)
    expect(snapshot.messages.filter(message => message.kind === 'narrative')).toEqual([expect.objectContaining({ text: '门内传来潮水的回声。' })])
    expect(snapshot.tools.map(tool => [tool.name, tool.status])).toEqual([['rp_write_turn', 'completed'], ['rp_commit_turn', 'completed']])
    const writerRequest = JSON.stringify(x.requests[1]?.messages)
    expect(writerRequest).not.toContain('call-0-0')
    expect(writerRequest).toContain('走进灯塔')
    expect(x.faults).toEqual([])
  })

  it('commits the explicit Agent narrative while retaining process commentary only in the model record', async () => {
    const x = setup([{ calls: [write] }, { text: 'Writer 初稿。' }, { text: '审阅完成，现在提交。', calls: [{ ...commit, args: { ...commit.args, narrative: '父模型修改后的完整正文。' } }] }], 'agent')
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(x.stories.snapshot(x.story.id).messages.at(-1)?.text).toBe('父模型修改后的完整正文。')
    expect(x.stories.run(x.run.id).draft).toBe('父模型修改后的完整正文。')
    expect(JSON.stringify(x.stories.eventLog(x.story.id))).toContain('审阅完成，现在提交。')
  })

  it('rejects an Agent commit without an explicit narrative instead of guessing from process text', async () => {
    const x = setup([{ calls: [write] }, { text: 'Writer 初稿。' }, { text: '审阅完成，现在提交。', calls: [commit] }], 'agent')
    const config = x.stories.snapshot(x.story.id).profile; config.runtime.maxSteps = 2
    x.stories.append(x.story.id, { type: 'profile.changed', data: { profile: config } })
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('failed')
    expect(x.stories.hasCommitted(x.run.id)).toBe(false)
    expect(x.stories.snapshot(x.story.id).tools.at(-1)?.status).toBe('failed')
  })

  it('answers an ordinary discussion without Writer or narrative state commits', async () => {
    const x = setup([{ text: '我会从叙述视角来回答。', calls: [{ name: 'rp_reply', args: { text: '可以调整故事的叙述视角。' } }] }])
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(x.stories.snapshot(x.story.id).messages.at(-1)).toMatchObject({ kind: 'message', text: '可以调整故事的叙述视角。' })
    expect(x.stories.eventLog(x.story.id).some(event => event.type === 'turn.committed')).toBe(false)
    expect(x.requests).toHaveLength(1)
    expect(x.stories.eventLog(x.story.id).filter(event => event.type === 'run.draft').map(event => event.data.text)).toEqual(['可以调整故事的叙述视角。'])
  })

  it('repairs a plain-text Chat narrative once through Writer without publishing the bypassed draft', async () => {
    const x = setup([{ text: '绕过 Writer 的错误正文。' }, { calls: [write] }, { text: 'Writer 的正确正文。' }, { calls: [commit] }])
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    const visible = x.stories.snapshot(x.story.id).messages.filter(message => message.kind !== 'tool')
    expect(visible.map(message => message.text)).toEqual(['走进灯塔。', 'Writer 的正确正文。'])
    expect(JSON.stringify(x.requests[1]?.messages)).toContain('绕过 Writer 的错误正文。')
    expect(JSON.stringify(x.stories.eventLog(x.story.id).filter(event => event.type === 'run.draft'))).not.toContain('绕过 Writer 的错误正文。')
    expect(x.requests).toHaveLength(4)
  })

  it('keeps repeatedly unfinalized Chat output in the trace without creating a conversation draft', async () => {
    const x = setup([{ text: '未走工具的第一次正文。' }, { text: '仍未走工具的第二次正文。' }])
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id)).toMatchObject({ status: 'failed', draft: '', error: { code: 'CHAT_RESPONSE_NOT_FINALIZED' } })
    expect(x.stories.snapshot(x.story.id).messages.filter(message => message.role === 'assistant')).toEqual([])
    const events = x.stories.eventLog(x.story.id)
    expect(events.filter(event => event.type === 'run.draft')).toEqual([])
    expect(JSON.stringify(events.filter(event => event.type === 'model.message'))).toContain('仍未走工具的第二次正文。')
    expect(x.stories.hasCommitted(x.run.id)).toBe(false)
    expect(x.requests).toHaveLength(2)
  })

  it('rejects a discussion finish after Writer and commits the existing narrative without rewriting', async () => {
    const x = setup([{ calls: [write] }, { text: 'Writer 的正文。' }, { calls: [{ name: 'rp_reply', args: { text: '冒充讨论的正文。' } }] }, { calls: [commit] }])
    x.queue.wake(); await x.queue.idle()
    const snapshot = x.stories.snapshot(x.story.id)
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(snapshot.messages.filter(message => message.kind !== 'tool').map(message => message.text)).toEqual(['走进灯塔。', 'Writer 的正文。'])
    expect(snapshot.tools.find(tool => tool.name === 'rp_reply')?.status).toBe('failed')
    expect(snapshot.tools.filter(tool => tool.name === 'rp_write_turn')).toHaveLength(1)
  })

  it('keeps uncommitted Writer text as a draft after a failed commit and exhausted steps', async () => {
    const x = setup([{ calls: [write] }, { text: '未提交的完整初稿。' }, { calls: [{ name: 'rp_commit_turn', args: { references: [{ source: 'missing', id: 'missing', revision: 99 }] } }] }])
    const config = x.stories.snapshot(x.story.id).profile; config.runtime.maxSteps = 2
    x.stories.append(x.story.id, { type: 'profile.changed', data: { profile: config } })
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id)).toMatchObject({ status: 'failed', draft: '未提交的完整初稿。' })
    expect(x.stories.snapshot(x.story.id).messages.some(message => message.kind === 'narrative')).toBe(false)
    expect(x.stories.snapshot(x.story.id).tools.at(-1)?.status).toBe('failed')
  })

  it('rejects commit arguments authored before seeing Writer output', async () => {
    const x = setup([{ calls: [write, commit] }, { text: '真实初稿。' }])
    const config = x.stories.snapshot(x.story.id).profile; config.runtime.maxSteps = 1
    x.stories.append(x.story.id, { type: 'profile.changed', data: { profile: config } })
    x.queue.wake(); await x.queue.idle()
    const snapshot = x.stories.snapshot(x.story.id)
    expect(x.stories.run(x.run.id).status).toBe('failed')
    expect(snapshot.messages.some(message => message.kind === 'narrative')).toBe(false)
    expect(JSON.stringify(snapshot.tools.at(-1)?.result)).toContain('WRITER_REVIEW_REQUIRED')
  })

  it('cancels an in-flight tool and retains its outcome without replay', async () => {
    const x = setup([{ text: '先等待工具返回，再决定正式答复。', calls: [{ name: 'wait_for_cancel', args: {} }] }], 'agent')
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let calls = 0
    x.resources.tools = () => [{ name: 'wait_for_cancel', label: '等待', description: '等待取消', parameters: Type.Object({}), execute: async (_id, _input, signal) => {
      calls += 1; started()
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
      return { content: [], details: {} }
    } }]
    x.queue.wake(); await ready
    expect(x.stories.run(x.run.id).draft).toBe('')
    await x.queue.cancel(x.run.id); await x.queue.idle()
    expect(calls).toBe(1)
    expect(x.stories.run(x.run.id).status).toBe('cancelled')
    expect(x.stories.snapshot(x.story.id).tools[0]?.status).not.toBe('running')
    expect(readingView(x.stories.snapshot(x.story.id)).story.messages.map(message => message.role)).toEqual(['user'])
    expect(x.requests).toHaveLength(1)
  })

  it('publishes a direct Agent answer only after the message finishes without tools', async () => {
    const x = setup([{ text: '这是正式的讨论答复。' }], 'agent')
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id)).toMatchObject({ status: 'completed', draft: '' })
    expect(x.stories.eventLog(x.story.id).filter(event => event.type === 'run.draft')).toEqual([])
    expect(readingView(x.stories.snapshot(x.story.id)).story.messages.at(-1)).toMatchObject({ role: 'assistant', kind: 'message', text: '这是正式的讨论答复。' })
  })
})

it('A02 retains failed Agent commit prose instead of a later acknowledgement, with edit/fork/delete recovery', async () => {
  const x = setup([{ calls: [write] }, { text: 'Writer 初稿。' }, { text: '审阅结果仅留在过程记录。', calls: [{ name: 'rp_commit_turn', args: { narrative: '修改后的完整正文。', references: [{ source: 'missing', id: 'missing', revision: 99 }] } }] }, { text: '暂时无法提交。' }], 'agent')
  x.queue.wake(); await x.queue.idle()
  expect(x.stories.run(x.run.id)).toMatchObject({ status: 'failed', draft: '修改后的完整正文。' })
  let story = x.stories.snapshot(x.story.id), draft = story.messages.find(message => message.kind === 'draft')!
  expect(draft.text).toBe('修改后的完整正文。')
  expect(story.messages.filter(message => message.kind === 'narrative')).toHaveLength(0)
  story = x.service.edit(story.id, story.revision, draft.id, '手动保存的草稿。')
  const branch = x.service.fork(story.id, story.revision, draft.id)
  expect(branch.messages.at(-1)).toMatchObject({ text: '手动保存的草稿。', kind: 'draft' })
  const next = x.service.send(branch.id, 'after-draft', [{ text: '继续构思', attachmentIds: [] }]).run
  x.stories.setRunStatus(next.id, 'running')
  const context = new ContextService(x.stories, x.assets).freeze(next.id, route)
  expect(JSON.stringify({ writerPrompt: context.writerPrompt, history: new ModelHistoryService(x.stories).read(x.stories.snapshot(branch.id), next.id) })).not.toContain('手动保存的草稿。')
  x.stories.setRunStatus(next.id, 'cancelled')
  x.service.remove(story.id, story.revision, draft.id)
  expect(x.stories.snapshot(story.id).messages.map(message => message.role)).toEqual(['user'])
})
