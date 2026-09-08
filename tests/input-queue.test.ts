import { afterEach, describe, expect, it } from 'vitest'
import { InputQueueService } from '../apps/server/src/services/input-queue-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { RunExecutor } from '../apps/server/src/runtime/executor.ts'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { SummaryService } from '../apps/server/src/services/summary-service.ts'
import { SUMMARY_HEADINGS } from '../packages/rp-core/src/context/summary.ts'
import { fixture, message, profile } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(item => item.close()))
const input = (text: string) => [{ text, attachmentIds: [] as string[] }]
function setup() {
  const x = fixture(); fixtures.push(x)
  const service = new StoryService(x.stories, x.assets, x.files), inputs = new InputQueueService(service), story = service.create('排队验收')
  return { ...x, service, inputs, story }
}

describe('durable pending input boundaries', () => {
  it('resumes pending messages when a manual summary finishes without another user action', async () => {
    const x = setup(), route = { provider: 'test', model: 'story' }, faults: unknown[] = []
    for (const [index, role] of (['user', 'assistant', 'user', 'assistant'] as const).entries()) x.stories.append(x.story.id, { type: 'message.added', data: { message: message(role, '灯塔记录。'.repeat(300), { turnId: String(Math.floor(index / 2)) }) } })
    let release!: (response: Response) => void
    const models = new ModelRegistry([{ ...route, keyEnv: 'SYNTHETIC', api: 'openai-completions', baseUrl: 'https://test.invalid/v1', contextWindow: 100000, maxTokens: 8000 }], { env: () => 'synthetic-test', fetch: () => new Promise(resolve => { release = resolve }) })
    const queue = new RunQueue(x.stories, async () => {}, error => faults.push(error), () => false, () => x.inputs.promote())
    const summary = new SummaryService(x.stories, models, error => faults.push(error), () => queue.wake())
    summary.startManual(x.story.id, x.stories.latestSequence(x.story.id), 'summary', route)
    const item = x.inputs.submit(x.story.id, 'after-summary', input('总结完成后继续'), 'queue').item
    queue.wake(); await queue.idle()
    expect(x.inputs.get(item.id).status).toBe('pending')
    await new Promise(resolve => setTimeout(resolve, 0))
    release(new Response(`data: ${JSON.stringify({ id: 'summary', choices: [{ index: 0, delta: { role: 'assistant', content: SUMMARY_HEADINGS.map(heading => `${heading}\n- 灯塔记录已核对。`).join('\n\n') }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
    await summary.idle(); await queue.idle(); await summary.close(); await queue.close()
    expect(x.stories.snapshot(x.story.id).maintenance.summary?.status).toBe('completed')
    expect(x.inputs.get(item.id).status).toBe('applied')
    expect(x.stories.run(x.inputs.get(item.id).appliedRunId!).status).toBe('completed')
    expect(faults).toEqual([])
  })
  it('keeps queued and edited input outside the active context, then materializes in FIFO order after its reply', async () => {
    const x = setup(), first = x.service.send(x.story.id, 'first', input('第一条')).run
    const second = x.inputs.submit(x.story.id, 'second', input('第二条'), 'queue').item
    const third = x.inputs.submit(x.story.id, 'third', input('第三条'), 'queue').item
    expect(x.inputs.submit(x.story.id, 'second', input('第二条'), 'queue').duplicate).toBe(true)
    expect(() => x.inputs.submit(x.story.id, 'second', input('不同'), 'queue')).toThrow('不同内容')
    x.inputs.update(x.story.id, second.id, second.revision, input('第二条改好'), 'queue')
    expect(() => x.inputs.update(x.story.id, second.id, second.revision, input('过时'), 'queue')).toThrow('已更新')
    x.inputs.remove(x.story.id, third.id, third.revision)
    expect(x.inputs.promote()).toBe(false)
    const contents: string[][] = [], faults: unknown[] = []
    const queue = new RunQueue(x.stories, async id => {
      const run = x.stories.run(id), story = x.stories.snapshot(run.storyId)
      contents.push(story.messages.filter(item => item.role === 'user').map(item => item.text))
      x.stories.append(run.storyId, { type: 'message.added', data: { message: message('assistant', id === first.id ? '第一条回复' : '第二条回复', { runId: id, turnId: run.turnId }) } })
    }, error => faults.push(error), () => false, () => x.inputs.promote())
    queue.wake(); await queue.idle(); await queue.close()
    expect(contents).toEqual([['第一条'], ['第一条', '第二条改好']])
    expect(x.stories.snapshot(x.story.id).messages.map(item => item.text)).toEqual(['第一条', '第一条回复', '第二条改好', '第二条回复'])
    expect(x.inputs.list(x.story.id)).toEqual([])
    expect(() => x.inputs.remove(x.story.id, second.id, 2)).toThrow('已经开始处理')
    expect(x.inputs.get(third.id).status).toBe('cancelled')
    expect(faults).toEqual([])
  })

  it('retains unconsumed steering after interruption and rejects cross-story requests', () => {
    const x = setup(), run = x.service.send(x.story.id, 'first', input('继续')).run
    x.stories.setRunStatus(run.id, 'running')
    const stop = x.inputs.register(run.id, { notify: () => {}, validate: () => {} })
    const other = x.service.create('其他会话')
    expect(() => x.inputs.submit(other.id, 'foreign', input('越界'), 'steer', run.id)).toThrow('本轮已经结束')
    const one = x.inputs.submit(x.story.id, 'steer', input('补充要求'), 'steer', run.id).item
    expect(x.stories.snapshot(x.story.id).messages.map(item => item.text)).toEqual(['继续'])
    stop(); x.stories.recoverInterrupted()
    const restarted = new InputQueueService(x.service)
    expect(restarted.get(one.id).status).toBe('pending')
    expect(restarted.promote()).toBe(true)
    expect(restarted.get(one.id).status).toBe('applied')
    expect(x.stories.snapshot(x.story.id).messages.map(item => item.text)).toEqual(['继续', '补充要求'])
  })

  it('converts an explicitly selected batch to steering atomically and consumes each message only once', () => {
    const x = setup(), run = x.service.send(x.story.id, 'first', input('继续')).run
    x.stories.setRunStatus(run.id, 'running')
    let notified = 0
    x.inputs.register(run.id, { notify: () => { notified++ }, validate: () => {} })
    const a = x.inputs.submit(x.story.id, 'a', input('方向一'), 'queue').item, b = x.inputs.submit(x.story.id, 'b', input('方向二'), 'queue').item
    expect(() => x.inputs.steerAll(x.story.id, run.id, [{ id: a.id, revision: 1 }, { id: b.id, revision: 9 }])).toThrow('已更新')
    expect(x.inputs.list(x.story.id).every(item => item.mode === 'queue')).toBe(true)
    x.inputs.steerAll(x.story.id, run.id, [a, b])
    expect(notified).toBe(1)
    expect(x.inputs.consumeSteering(run.id)).toBe(true)
    expect(x.inputs.consumeSteering(run.id)).toBe(false)
    expect(x.stories.snapshot(x.story.id).messages.map(item => [item.text, item.runId])).toEqual([['继续', run.id], ['方向一', run.id], ['方向二', run.id]])
  })
})

for (const arrival of ['writer', 'commit', 'options'] as const) it(`real Pi steering during ${arrival} cannot commit stale Writer prose`, async () => {
  const x = setup(), requests: Record<string, unknown>[] = [], route = { provider: 'test', model: 'story' }
  const run = x.service.send(x.story.id, 'first', input('原始要求')).run
  const write = { name: 'rp_write_turn', args: { action: 'write' } }, commit = { name: 'rp_commit_turn', args: {} }
  const script = arrival === 'writer'
    ? [{ call: write }, { text: '不再适用的初稿' }, { call: write }, { text: '遵守补充要求的新稿' }, { call: commit }]
    : [{ call: write }, { text: '不再适用的初稿' }, { call: commit }, { call: write }, { text: '遵守补充要求的新稿' }, { call: commit }]
  const models = new ModelRegistry([{ ...route, keyEnv: 'SYNTHETIC', api: 'openai-completions', baseUrl: 'https://test.invalid/v1', contextWindow: 100000, maxTokens: 8000 }], { env: () => 'synthetic-test', fetch: async (_url, init) => {
    const index = requests.length, next = script[index]!
    requests.push(JSON.parse(String(init?.body)))
    if (arrival !== 'options' && index === (arrival === 'writer' ? 1 : 2)) x.inputs.submit(x.story.id, 'steering', input('补充要求：保持灯塔大门关闭。'), 'steer', run.id)
    const delta = { role: 'assistant', content: next.text ?? '', ...(next.call ? { tool_calls: [{ index: 0, id: `test-${index}`, type: 'function', function: { name: next.call.name, arguments: JSON.stringify(next.call.args) } }] } : {}) }
    return new Response(`data: ${JSON.stringify({ id: `reply-${index}`, choices: [{ index: 0, delta, finish_reason: next.call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  } })
  const executor = new RunExecutor(x.stories, new ContextService(x.stories, x.assets), new TurnService(x.stories), models, x.files, undefined, x.inputs)
  let generations = 0
  const faults: unknown[] = [], queue = new RunQueue(x.stories, (id, signal) => executor.execute(id, signal, { routes: { main: route, writer: route }, files: [], images: [], readonlyTools: [], specialists: [], tools: () => [],
    ...(arrival === 'options' ? { replyOptions: async () => {
      generations++
      if (generations === 1) x.inputs.submit(x.story.id, 'steering', input('补充要求：保持灯塔大门关闭。'), 'steer', run.id)
      return { extensions: { 'rp.reply-options': { version: 1, options: [generations === 1 ? '打开大门。' : '留在门内。'] } }, diagnostics: [] }
    } } : {}),
  }), error => faults.push(error))
  queue.wake(); await queue.idle(); await queue.close()
  expect(x.stories.run(run.id)).toMatchObject({ status: 'completed', error: null })
  expect(x.stories.snapshot(x.story.id).messages.filter(item => item.kind !== 'tool').map(item => item.text)).toEqual(['原始要求', '补充要求：保持灯塔大门关闭。', '遵守补充要求的新稿'])
  expect(JSON.stringify(requests[1])).not.toContain('保持灯塔大门关闭')
  expect(JSON.stringify(requests[arrival === 'writer' ? 3 : 4])).toContain('保持灯塔大门关闭')
  expect(x.stories.eventsOfTypes(x.story.id, ['turn.committed'])).toHaveLength(1)
  expect(x.inputs.list(x.story.id)).toEqual([])
  expect(faults).toEqual([])
  if (arrival === 'options') {
    expect(generations).toBe(2)
    expect(Object.values(x.stories.snapshot(x.story.id).replyOptions)).toEqual([['留在门内。']])
  }
})
