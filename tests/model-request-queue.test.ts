import { expect, it } from 'vitest'
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import { ModelRequestQueue } from '../apps/server/src/runtime/model-request-queue.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { ConcurrencyService } from '../apps/server/src/services/concurrency-service.ts'
import { fixture } from './helpers.ts'

const registered = (provider: string, model = 'synthetic') => ({ provider, model, keyEnv: 'TEST_KEY', api: 'openai-completions' as const, baseUrl: 'https://synthetic.invalid/v1' })
const model = (provider: string) => new ModelRegistry([registered(provider)], { env: () => 'synthetic' }).resolve({ provider, model: 'synthetic' }).model
function message(model: Model<Api>, aborted = false): AssistantMessage {
  return { role: 'assistant', provider: model.provider, model: model.id, api: model.api, content: [], timestamp: 0, stopReason: aborted ? 'aborted' : 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}
function harness(queue: ModelRequestQueue) {
  const started: string[] = [], finishes = new Map<string, () => void>(), phases: Record<string, boolean[]> = {}
  function request(id: string, provider = 'a', signal?: AbortSignal) {
    const target = model(provider)
    return queue.stream(target, signal => {
      started.push(id)
      const stream = createAssistantMessageEventStream()
      const end = () => { signal.removeEventListener('abort', abort); stream.push({ type: 'done', reason: 'stop', message: message(target) }); stream.end() }
      const abort = () => { stream.push({ type: 'error', reason: 'aborted', error: message(target, true) }); stream.end() }
      signal.addEventListener('abort', abort, { once: true }); finishes.set(id, end)
      return stream
    }, signal, queued => { (phases[id] ??= []).push(queued) })
  }
  return { request, started, phases, finish: (id: string) => finishes.get(id)!() }
}

it('shares connection capacity across roles, keeps whole streams bounded, and bypasses a saturated connection fairly', async () => {
  const queue = new ModelRequestQueue(() => ({ maxRequests: 3, maxRequestsPerConnection: 2 })), h = harness(queue)
  const main = h.request('main'), writer = h.request('writer'), task = h.request('task'), summary = h.request('summary'), other = h.request('other', 'b')
  await expect.poll(() => h.started).toEqual(['main', 'writer', 'other'])
  expect(queue.status()).toEqual({ active: 3, queued: 2 })
  expect(h.phases.task).toEqual([true])
  h.finish('writer'); await writer.result()
  await expect.poll(() => h.started).toEqual(['main', 'writer', 'other', 'task'])
  expect(h.phases.task).toEqual([true, false])
  h.finish('main'); await main.result()
  await expect.poll(() => h.started.at(-1)).toBe('summary')
  h.finish('task'); h.finish('summary'); h.finish('other')
  await Promise.all([task.result(), summary.result(), other.result()])
  await expect.poll(() => queue.status()).toEqual({ active: 0, queued: 0 })
})

it('removes cancelled waiting requests without dispatch and aborts all requests on shutdown', async () => {
  const queue = new ModelRequestQueue(() => ({ maxRequests: 1, maxRequestsPerConnection: 1 })), h = harness(queue), abort = new AbortController()
  const active = h.request('active'), cancelled = h.request('cancelled', 'a', abort.signal), waiting = h.request('waiting')
  abort.abort()
  expect((await cancelled.result()).stopReason).toBe('aborted')
  expect(h.started).toEqual(['active'])
  queue.close()
  expect((await active.result()).stopReason).toBe('aborted')
  expect((await waiting.result()).stopReason).toBe('aborted')
  const late = h.request('late')
  expect((await late.result()).stopReason).toBe('aborted')
  expect(h.started).toEqual(['active'])
  await expect.poll(() => queue.status()).toEqual({ active: 0, queued: 0 })
})

it('wakes waiting work when saved limits rise, drains without cancellation when they fall, and persists settings', async () => {
  const x = fixture()
  const settings = new ConcurrencyService(x.assets, () => queue.wake()), queue = new ModelRequestQueue(() => settings.snapshot().settings), h = harness(queue)
  try {
    settings.update(1, { maxRequests: 1, maxRequestsPerConnection: 1 })
    const first = h.request('first'), second = h.request('second'), third = h.request('third')
    await expect.poll(() => h.started).toEqual(['first'])
    settings.update(2, { maxRequests: 2, maxRequestsPerConnection: 2 })
    await expect.poll(() => h.started).toEqual(['first', 'second'])
    settings.update(3, { maxRequests: 1, maxRequestsPerConnection: 1 })
    h.finish('first'); await first.result()
    await expect.poll(() => queue.status()).toEqual({ active: 1, queued: 1 })
    expect(h.started).toEqual(['first', 'second'])
    h.finish('second'); await second.result()
    await expect.poll(() => h.started.at(-1)).toBe('third')
    h.finish('third'); await third.result()
    expect(new ConcurrencyService(x.assets).snapshot()).toEqual(settings.snapshot())
    expect(() => settings.update(2, { maxRequests: 4, maxRequestsPerConnection: 2 })).toThrow('已经更新')
    for (const bad of [0, -1, 33, 1.5, '4', NaN]) expect(() => settings.update(4, { maxRequests: bad, maxRequestsPerConnection: 2 })).toThrow('1 到 32')
    expect(() => settings.update(4, { maxRequests: 1, maxRequestsPerConnection: 1, extra: true })).toThrow('完整')
  } finally { queue.close(); x.close() }
})

it('terminates setup and malformed-stream failures and releases their request slots', async () => {
  const queue = new ModelRequestQueue(() => ({ maxRequests: 1, maxRequestsPerConnection: 1 })), target = model('a')
  const failed = queue.stream(target, () => { throw new Error('synthetic setup failure') })
  const empty = queue.stream(target, () => { const stream = createAssistantMessageEventStream(); stream.end(); return stream })
  expect((await failed.result()).stopReason).toBe('error')
  expect((await empty.result()).stopReason).toBe('error')
  await expect.poll(() => queue.status()).toEqual({ active: 0, queued: 0 })
})

it('enforces shared limits through the real Pi adapter until SSE finishes, including registry replacement and separate models', async () => {
  const queue = new ModelRequestQueue(() => ({ maxRequests: 2, maxRequestsPerConnection: 1 })), requests: string[] = [], endings = new Map<string, () => void>()
  const registry = new ModelRegistry([registered('a', 'main'), registered('a', 'writer'), registered('b', 'other')], { requests: queue, env: () => 'synthetic', fetch: async (_url, options) => {
    const id = JSON.parse(String(options?.body)).model as string; requests.push(id)
    const body = new ReadableStream({ start(controller) { endings.set(id, () => { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'complete' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')); controller.close() }) } })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  } })
  const request = (provider: string, id: string) => registry.stream(registry.resolve({ provider, model: id }).model, { messages: [] }).result()
  const first = request('a', 'main')
  await expect.poll(() => requests).toEqual(['main'])
  registry.replace(registry.registrations())
  const next = request('a', 'writer'), other = request('b', 'other')
  await expect.poll(() => requests).toEqual(['main', 'other'])
  expect(queue.status()).toEqual({ active: 2, queued: 1 })
  endings.get('main')!(); expect((await first).stopReason).toBe('stop')
  await expect.poll(() => requests).toEqual(['main', 'other', 'writer'])
  endings.get('other')!(); endings.get('writer')!()
  expect((await other).stopReason).toBe('stop'); expect((await next).stopReason).toBe('stop')
  await expect.poll(() => queue.status()).toEqual({ active: 0, queued: 0 })
})
