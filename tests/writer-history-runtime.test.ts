import { afterEach, expect, it, vi } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { ModelRegistry, type ModelRegistration } from '../apps/server/src/runtime/models.ts'
import { runIsolated } from '../apps/server/src/runtime/isolated.ts'
import { nativeWriterHistory } from '../apps/server/src/runtime/writer-history.ts'
import { WriterHistoryService } from '../apps/server/src/services/writer-history-service.ts'
import { fixture } from './helpers.ts'
import { historyConfig, historyTextResponse } from './writer-history-fixture.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
const registration: ModelRegistration = { provider: 'test', model: 'writer', keyEnv: 'TEST_KEY', api: 'openai-completions', baseUrl: 'https://model.test/v1', contextWindow: 100_000, maxTokens: 8000 }
const route = { provider: 'test', model: 'writer' }
function history() { const x = fixture(); cleanup.push(x.close); const service = new WriterHistoryService(x.assets); service.update(1, historyConfig()); return service.capture()! }

it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)('sends paired, lossless native history with an empty tool table through the real %s adapter', async api => {
  const captured: string[] = []
  const models = new ModelRegistry([{ ...registration, api }], { env: () => 'test-only', fetch: async (_url, init) => {
    captured.push(String(init?.body)); return new Response('{"error":{"message":"capture-only"}}', { status: 400 })
  } })
  const { model } = models.resolve(route)
  await models.stream(model, { systemPrompt: '真实系统提示', messages: [...nativeWriterHistory(history(), model), { role: 'user', content: '真实上下文', timestamp: 1 }], tools: [] }).result()
  expect(captured).toHaveLength(1)
  const body = JSON.parse(captured[0]!)
  expect(body.tools ?? []).toEqual([])
  if (api === 'openai-completions') {
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant', 'user'])
    expect(body.messages[3].tool_call_id).toBe(body.messages[2].tool_calls[0].id)
    expect(body.messages[5].tool_call_id).toBe(body.messages[4].tool_calls[0].id)
    expect(body.messages[4].tool_calls[0].function.arguments).toContain('900719925474099312345')
  } else if (api === 'openai-responses') {
    const calls = body.input.filter((item: { type: string }) => item.type === 'function_call'), results = body.input.filter((item: { type: string }) => item.type === 'function_call_output')
    expect(calls).toHaveLength(3); expect(results.map((item: { call_id: string }) => item.call_id)).toEqual(calls.map((item: { call_id: string }) => item.call_id))
    expect(calls[1].arguments).toContain('900719925474099312345')
    expect(calls.every((item: { name: string }) => /^[a-zA-Z0-9_-]+$/.test(item.name))).toBe(true)
  } else {
    const blocks = body.messages.flatMap((item: { content: object[] }) => item.content)
    const calls = blocks.filter((item: { type: string }) => item.type === 'tool_use'), results = blocks.filter((item: { type: string }) => item.type === 'tool_result')
    expect(calls).toHaveLength(3); expect(results[0].is_error).toBe(true); expect(results[1].is_error).toBe(false)
    expect(results.map((item: { tool_use_id: string }) => item.tool_use_id)).toEqual(calls.map((item: { id: string }) => item.id))
  }
  expect(captured[0]).toContain('900719925474099312345')
  expect(captured[0]).toContain('1.000000000000000001')
  expect(captured[0]).toContain('1e400')
  expect(captured[0]).not.toContain('argumentsJson')
})

it('never executes preset tools or emits live events for them, and returns only newly generated Writer text', async () => {
  const execute = vi.fn(), events: string[] = [], messages: object[] = [], requests: string[] = []
  const models = new ModelRegistry([registration], { env: () => 'test', fetch: async (_url, init) => { requests.push(String(init?.body)); return historyTextResponse() } })
  const result = await runIsolated(models, { route, systemPrompt: '系统', prompt: '写作上下文', images: [], initialHistory: history(),
    tools: [{ name: 'read_log', label: 'Read', description: 'Read', parameters: Type.Object({}), execute }], maxSteps: 1, signal: new AbortController().signal,
    onEvent: event => events.push(event.type), onMessage: message => messages.push(message) })
  expect(result.text).toBe('灯塔的门缓缓打开。')
  expect(execute).not.toHaveBeenCalled()
  expect(events.some(type => type.startsWith('tool_execution'))).toBe(false)
  expect(messages).toHaveLength(2)
  expect(JSON.parse(requests[0]!).tools).toHaveLength(1)
  expect(JSON.stringify(messages)).not.toContain('日期修正后已读取记录')
})

it('does not mistake preset assistant text for final output on a failed or empty real response', async () => {
  for (const response of [() => historyTextResponse(''), () => new Response('{"error":{"message":"failed"}}', { status: 400 })]) {
    const models = new ModelRegistry([registration], { env: () => 'test', fetch: async () => response() })
    await expect(runIsolated(models, { route, systemPrompt: '系统', prompt: '当前输入', images: [], tools: [], initialHistory: history(), maxSteps: 1, signal: new AbortController().signal })).rejects.toThrow()
  }
})

it('preserves the complete historical prefix during overflow recovery and tool-result pruning', async () => {
  const preset = history(), result = preset.messages[2]!
  if (result.role !== 'toolResult') throw new Error('fixture')
  result.toolName = 'read'; result.content[0]!.text = JSON.stringify({ text: 'x'.repeat(9000) })
  const requests: Record<string, any>[] = [], models = new ModelRegistry([registration], { env: () => 'test', fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return requests.length === 1 ? new Response('{"error":{"message":"maximum context length exceeded","code":"context_length_exceeded"}}', { status: 400 }) : historyTextResponse()
  } })
  const recover = vi.fn(async () => ({ systemPrompt: '压缩后系统', prompt: '压缩后真实输入' }))
  await runIsolated(models, { route, systemPrompt: '系统', prompt: '压缩前真实输入', images: [], tools: [], initialHistory: preset, maxSteps: 1, signal: new AbortController().signal, recoverOverflow: recover })
  expect(recover).toHaveBeenCalledOnce()
  expect(requests).toHaveLength(2)
  expect(requests[1]!.messages.slice(1, 11)).toEqual(requests[0]!.messages.slice(1, 11))
  expect(requests[1]!.messages.at(-1).content).toEqual([{ type: 'text', text: '压缩后真实输入' }])
  expect(JSON.stringify(requests)).not.toContain('工具结果中段已省略')
})
