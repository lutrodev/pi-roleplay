import { afterEach, describe, expect, it } from 'vitest'
import { SummaryService } from '../apps/server/src/services/summary-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import { RpError } from '../packages/rp-core/src/errors.ts'
import { SUMMARY_HEADINGS } from '../packages/rp-core/src/context/summary.ts'
import { fixture, message, profile } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
const route = { provider: 'synthetic', model: 'summary' }
const summaryText = SUMMARY_HEADINGS.map((heading, index) => `${heading}\n- ${index ? '（无）' : '旅人到达了灯塔。'}`).join('\n\n')
function setup(singleExchange = false) {
  const x = fixture(), story = x.stories.create('前情', profile()), service = new StoryService(x.stories, x.assets, x.files)
  const messages = [message('user', '他们沿着海岸步行。'.repeat(500), { turnId: 'old' }), message('assistant', '旅人到达了灯塔。'.repeat(500), { kind: 'narrative', turnId: 'old' }),
    message('user', '继续。', { turnId: 'recent' }), message('assistant', '窗前有一封信。', { kind: 'narrative', turnId: 'recent' })]
  if (singleExchange) messages.splice(2)
  for (const item of messages) x.stories.append(story.id, { type: 'message.added', data: { message: item } })
  const requests: unknown[] = [], faults: unknown[] = []
  let respond!: (response: Response) => void
  const models = new ModelRegistry([{ ...route, keyEnv: 'SUMMARY_KEY', api: 'openai-completions', baseUrl: 'https://model.test/v1', contextWindow: 128000, maxTokens: 8192 }], {
    env: () => 'synthetic-key', fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(new Error('cancelled'))
        init?.signal?.addEventListener('abort', abort, { once: true })
        respond = value => { init?.signal?.removeEventListener('abort', abort); resolve(value) }
        if (init?.signal?.aborted) abort()
      })
    },
  })
  const summaries = new SummaryService(x.stories, models, error => faults.push(error))
  cleanup.push(async () => { await summaries.close(); x.close(); expect(faults).toEqual([]) })
  const complete = (text = summaryText, finish = 'stop') => respond(new Response(`data: ${JSON.stringify({ id: 'summary', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
  const pressure = (runId: string) => summaries.pressure(runId, [{ route, text: '压'.repeat(120000) }], route)
  return { ...x, storyId: story.id, service, summaries, models, requests, messages, complete, pressure }
}

describe('durable summary lifecycle', () => {
  it('starts at exactly 80 percent including the output reserve and waits for a successful prior run only at the next boundary', async () => {
    const x = setup(), run = x.service.send(x.storyId, 'turn-n', [{ text: '当前输入', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running')
    const inputTokens = 128000 * 0.8 - 8192
    x.summaries.pressure(run.id, [{ route, text: 'a'.repeat((inputTokens - 1) * 3) }], route)
    expect(x.summaries.activeCount).toBe(0)
    x.summaries.pressure(run.id, [{ route, text: 'a'.repeat(inputTokens * 3) }], route)
    await expect.poll(() => x.requests.length).toBe(1)
    x.stories.setRunStatus(run.id, 'completed'); x.summaries.settleRun(run.id)
    expect(x.summaries.activeCount).toBe(1)
    const next = x.service.send(x.storyId, 'next', [{ text: '下一轮', attachmentIds: [] }]).run
    let started = false
    const ready = x.summaries.beforeRun(next.id, new AbortController().signal).then(() => { started = true })
    await Promise.resolve()
    expect(started).toBe(false); expect(x.stories.snapshot(x.storyId).checkpoint).toBeNull()
    x.complete(); await ready
    expect(x.stories.snapshot(x.storyId).checkpoint?.text).toBe(summaryText)
  })

  it.each([true, false])('manually summarizes all uncovered exchanges, including a single exchange (%s), without changing originals', async singleExchange => {
    const x = setup(singleExchange), before = x.stories.snapshot(x.storyId)
    const accepted = x.summaries.startManual(x.storyId, before.revision, 'manual', route)
    expect(x.summaries.startManual(x.storyId, before.revision, 'manual', route)).toEqual({ ...accepted, duplicate: true })
    expect(() => x.service.send(x.storyId, 'blocked', [{ text: '不能在手动总结时发送。', attachmentIds: [] }])).toThrow('整理前情')
    expect(() => x.service.edit(x.storyId, x.stories.snapshot(x.storyId).revision, x.messages[0]!.id, '修正')).toThrow('整理前情')
    await expect.poll(() => x.requests.length).toBe(1)
    x.complete(); await x.summaries.idle()
    const after = x.stories.snapshot(x.storyId)
    expect(after.messages).toEqual(before.messages); expect(after.state).toEqual(before.state)
    expect(after.checkpoint).toMatchObject({ sourceMessageIds: x.messages.map(message => message.id), text: summaryText })
    expect(after.maintenance.summary?.status).toBe('completed')
    if (!singleExchange) expect(JSON.stringify(x.requests[0])).toContain('窗前有一封信')
    expect(() => x.summaries.startManual(x.storyId, after.revision, 'nothing-new', route)).toThrow('没有尚未总结')
    expect(x.stories.eventLog(x.storyId).filter(event => event.type === 'maintenance.model')).toHaveLength(2)
    x.service.edit(x.storyId, after.revision, x.messages[0]!.id, '修正较早的原文。')
    expect(x.stories.snapshot(x.storyId).checkpoint).toBeNull()
  })

  it.each(['failed', 'cancelled', 'interrupted'] as const)('aborts pending pressure work immediately when its run is %s and lets the next run start', async outcome => {
    const x = setup(), run = x.service.send(x.storyId, 'turn-n', [{ text: '本轮', attachmentIds: [] }]).run
    let fail!: () => void
    const end = new Promise<void>((_resolve, reject) => { fail = () => reject(new RpError('TEST_FAILED', '受控失败')) })
    const queue = new RunQueue(x.stories, async (id, signal) => {
      await x.summaries.beforeRun(id, signal)
      if (id !== run.id) return
      x.pressure(id)
      await Promise.race([end, new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])
    }, () => {}, undefined, undefined, id => x.summaries.settleRun(id))
    try {
      queue.wake(); await expect.poll(() => x.requests.length).toBe(1)
      if (outcome === 'failed') fail()
      else if (outcome === 'cancelled') await queue.cancel(run.id)
      else await queue.close()
      await queue.idle(); await x.summaries.idle()
      expect(x.stories.run(run.id).status).toBe(outcome)
      expect(x.summaries.activeCount).toBe(0)
      expect(x.stories.snapshot(x.storyId)).toMatchObject({ checkpoint: null, summaryCandidate: null, maintenance: { summary: { status: 'discarded', code: 'SUMMARY_STALE' } } })
      const next = x.service.send(x.storyId, 'next', [{ text: '下一轮', attachmentIds: [] }]).run
      await x.summaries.beforeRun(next.id, new AbortController().signal)
      expect(x.requests).toHaveLength(1)
    } finally { await queue.close() }
  })

  it('discards an already ready candidate at the failed turn boundary without waiting for another turn', async () => {
    const x = setup(), run = x.service.send(x.storyId, 'turn-n', [{ text: '本轮', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running'); x.pressure(run.id)
    await expect.poll(() => x.requests.length).toBe(1); x.complete(); await x.summaries.idle()
    x.stories.setRunStatus(run.id, 'failed'); x.summaries.settleRun(run.id)
    expect(x.stories.snapshot(x.storyId).summaryCandidate).toBeNull()
    expect(x.stories.snapshot(x.storyId).maintenance.summary?.code).toBe('SUMMARY_STALE')
  })

  it('discards a ready candidate when restart discovers its triggering run never finished', async () => {
    const x = setup(), run = x.service.send(x.storyId, 'turn-n', [{ text: '本轮', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running'); x.pressure(run.id)
    await expect.poll(() => x.requests.length).toBe(1); x.complete(); await x.summaries.idle()
    x.summaries.recover()
    expect(x.stories.snapshot(x.storyId).summaryCandidate).toBeNull()
    expect(x.stories.snapshot(x.storyId).maintenance.summary?.code).toBe('SUMMARY_STALE')
    expect(x.requests).toHaveLength(1)
  })

  it('persists a pressure candidate for the next successful turn boundary, including across restart', async () => {
    const x = setup(), run = x.service.send(x.storyId, 'turn-n', [{ text: '本轮输入不进入总结。', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running'); x.pressure(run.id)
    await expect.poll(() => x.requests.length).toBe(1); x.complete(); await x.summaries.idle()
    expect(x.stories.snapshot(x.storyId).checkpoint).toBeNull()
    expect(x.stories.snapshot(x.storyId).summaryCandidate?.source.sourceMessageIds).toEqual(x.messages.map(message => message.id))
    expect(JSON.stringify(x.requests[0])).not.toContain('本轮输入不进入总结')
    x.stories.setRunStatus(run.id, 'completed')
    const next = x.service.send(x.storyId, 'turn-next', [{ text: '下一轮', attachmentIds: [] }]).run
    const restarted = new SummaryService(x.stories, x.models, () => {}); restarted.recover()
    await restarted.beforeRun(next.id, new AbortController().signal)
    expect(x.stories.snapshot(x.storyId).checkpoint?.sourceMessageIds).toHaveLength(4)
    expect(x.stories.snapshot(x.storyId).summaryCandidate).toBeNull()
    expect(x.requests).toHaveLength(1)
  })

  it.each(['failed', 'edited'] as const)('discards a candidate when the previous turn is %s', async outcome => {
    const x = setup(), run = x.service.send(x.storyId, 'turn-n', [{ text: '本轮', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running'); x.pressure(run.id)
    await expect.poll(() => x.requests.length).toBe(1); x.complete(); await x.summaries.idle()
    x.stories.setRunStatus(run.id, outcome === 'failed' ? 'failed' : 'completed')
    if (outcome === 'edited') x.service.edit(x.storyId, x.stories.snapshot(x.storyId).revision, x.messages[0]!.id, '事实已修改')
    const next = x.service.send(x.storyId, 'next', [{ text: '下一轮', attachmentIds: [] }]).run
    await x.summaries.beforeRun(next.id, new AbortController().signal)
    expect(x.stories.snapshot(x.storyId).checkpoint).toBeNull()
    expect(x.stories.snapshot(x.storyId).maintenance.summary?.code).toBe('SUMMARY_STALE')
  })

  it('keeps history after a truncated summary and releases a cancelled manual lock; restart never repeats an unfinished request', async () => {
    const x = setup()
    x.summaries.startManual(x.storyId, x.stories.snapshot(x.storyId).revision, 'truncated', route)
    await expect.poll(() => x.requests.length).toBe(1); x.complete(summaryText, 'length'); await x.summaries.idle()
    expect(x.stories.snapshot(x.storyId).maintenance.summary?.code).toBe('SUMMARY_INCOMPLETE')
    expect(x.stories.snapshot(x.storyId).checkpoint).toBeNull()
    const next = x.summaries.startManual(x.storyId, x.stories.snapshot(x.storyId).revision, 'cancel', route)
    await expect.poll(() => x.requests.length).toBe(2); await x.summaries.cancel(x.storyId, next.id)
    x.stories.assertIdle(x.storyId)
    x.stories.append(x.storyId, { type: 'maintenance.status', data: { id: 'crashed', kind: 'summary', trigger: 'manual', status: 'running' } })
    x.summaries.recover(); x.stories.assertIdle(x.storyId)
    expect(x.stories.snapshot(x.storyId).maintenance.summary?.code).toBe('PROCESS_INTERRUPTED')
    expect(x.requests).toHaveLength(2)
  })
})
