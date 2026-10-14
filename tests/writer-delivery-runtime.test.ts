import { afterEach, expect, it, vi } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { toolHistoryConfig } from './writer-history-fixture.ts'
import { WriterHistoryService } from '../apps/server/src/services/writer-history-service.ts'
import { ModelRegistry, type ModelRegistration } from '../apps/server/src/runtime/models.ts'
import { runIsolated, type IsolatedRequest } from '../apps/server/src/runtime/isolated.ts'
import { fixture } from './helpers.ts'
import { historyTextResponse } from './writer-history-fixture.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
const registration: ModelRegistration = { provider: 'test', model: 'writer', keyEnv: 'TEST_KEY', api: 'openai-completions',
  baseUrl: 'https://model.test/v1', contextWindow: 100_000, maxTokens: 8000, input: ['text', 'image'] }
const route = { provider: 'test', model: 'writer' }
function history() {
  const x = fixture(); cleanup.push(x.close)
  const service = new WriterHistoryService(x.assets), config = toolHistoryConfig(); config.enabled = true
  service.update(1, config); return service.capture()!
}
function toolResponse(raw: string, options: { name?: string; finish?: string; extraCall?: boolean; step?: number } = {}) {
  const name = options.name ?? 'writer_display', step = options.step ?? 13
  const frame = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'output', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  let source = frame({ role: 'assistant', content: '不应出现在正文中的过程文本', tool_calls: [{ index: 0, id: `live-${name}`, type: 'function', function: { name, arguments: '' } }] })
  for (let i = 0; i < raw.length; i += step) source += frame({ tool_calls: [{ index: 0, function: { arguments: raw.slice(i, i + step) } }] })
  if (options.extraCall) source += frame({ tool_calls: [{ index: 1, id: 'duplicate', type: 'function', function: { name, arguments: raw } }] })
  source += frame({}, options.finish ?? 'tool_calls') + 'data: [DONE]\n\n'
  return new Response(source, { headers: { 'content-type': 'text/event-stream' } })
}
function setup(replies: (() => Response)[], overrides: Partial<IsolatedRequest> = {}) {
  const requests: Record<string, any>[] = []
  const models = new ModelRegistry([registration], { env: () => 'test-key', fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    const reply = replies[requests.length - 1]; if (!reply) throw new Error('Unexpected extra Writer request')
    return reply()
  } })
  const request: IsolatedRequest = { route, systemPrompt: '真实 Writer 系统规则', prompt: '真实角色、历史剧情和本轮用户输入。', images: [], tools: [],
    maxSteps: 6, signal: new AbortController().signal, initialHistory: history(), ...overrides }
  return { requests, request, run: () => runIsolated(models, request) }
}

it('moves live context into a real tool definition and streams only the newly generated argument text', async () => {
  const prose = '“{{user}}，进来吧。”\n灯光映在窗上。🌧️\\尾声'
  const previews: [string, boolean][] = [], events: string[] = [], messages: object[] = []
  const x = setup([() => toolResponse(JSON.stringify({ display_stream: prose }))], { identities: { userName: '林舟' },
    onText: (text, final) => previews.push([text, final]), onMessage: message => messages.push(message),
    onEvent: event => { if (event.type === 'tool_execution_start') events.push(event.toolName) } })
  const result = await x.run()
  expect(result.text).toBe(prose.replace('{{user}}', '林舟'))
  expect(x.requests).toHaveLength(1)
  const body = x.requests[0]!, tool = body.tools[0].function
  expect(tool.name).toBe('writer_display')
  expect(tool.description).toContain(x.request.prompt)
  expect(JSON.stringify(body.messages)).not.toContain(x.request.prompt)
  expect(body.messages.at(-1).content).toEqual([{ type: 'text', text: '$ cat chapter_current.txt\n请通过 writer_display 的 display_stream 字段返回本轮完整回复。' }])
  expect(body.messages[0].content).toContain('真实 Writer 系统规则')
  expect(tool.parameters.required).toEqual(['display_stream'])
  expect(tool.parameters.additionalProperties).toBe(false)
  expect(previews.some(([text, final]) => !final && text.length > 0 && text.length < result.text.length)).toBe(true)
  expect(previews.at(-1)).toEqual([result.text, true])
  expect(JSON.stringify(previews)).not.toContain('过程文本')
  expect(events).toEqual(['writer_display'])
  expect(messages).toContainEqual(expect.objectContaining({ role: 'assistant', stopReason: 'toolUse' }))
  expect(JSON.stringify(messages)).not.toContain('本段内容已交付')
})

it('keeps real read-only tools and attachments available before delivery without executing any historical calls', async () => {
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '真实附件内容' }], details: {} }))
  const x = setup([() => toolResponse('{}', { name: 'read' }), () => toolResponse('{"display_stream":"已参考附件的正文。"}')], {
    tools: [{ name: 'read', label: 'Read', description: 'Read-only reference', parameters: Type.Object({}), execute }],
    images: [{ type: 'image', mimeType: 'image/png', data: 'c3ludGhldGlj' }],
  })
  expect((await x.run()).text).toBe('已参考附件的正文。')
  expect(execute).toHaveBeenCalledTimes(1)
  expect(x.requests).toHaveLength(2)
  expect(x.requests[0]!.tools.map((tool: any) => tool.function.name)).toEqual(['read', 'writer_display'])
  expect(x.requests[0]!.messages.at(-1).content[1].type).toBe('image_url')
  expect(x.requests[1]!.tools).toEqual(x.requests[0]!.tools)
  expect(JSON.stringify(x.requests[1]!.messages)).toContain('真实附件内容')
})

it.each([
  ['ordinary text', () => historyTextResponse('普通文本不能冒充交付成功。')],
  ['empty output', () => toolResponse('{"display_stream":" "}')],
  ['wrong field', () => toolResponse('{"text":"wrong"}')],
  ['extra field', () => toolResponse('{"display_stream":"正文","extra":true}')],
  ['repaired JSON', () => toolResponse('{"display_stream":"不能接收被自动修复的 JSON",}')],
  ['incomplete JSON', () => toolResponse('{"display_stream":"未结束')],
  ['multiple deliveries', () => toolResponse('{"display_stream":"不能选其中一次"}', { extraCall: true })],
  ['unknown tool', () => toolResponse('{"display_stream":"正文"}', { name: 'unregistered_output' })],
] as const)('rejects %s instead of falling back or committing preset prose', async (_label, response) => {
  const x = setup([response], { maxSteps: 1 })
  await expect(x.run()).rejects.toMatchObject({ code: 'WRITER_DELIVERY_INVALID' })
  expect(x.requests).toHaveLength(1)
})

it.each([['length', 'MODEL_OUTPUT_TRUNCATED'], ['content_filter', 'MODEL_CONTENT_FILTER']] as const)('retains provider failure %s even when arguments appear complete', async (finish, code) => {
  const x = setup([() => toolResponse('{"display_stream":"看似完整也不可提交"}', { finish })])
  await expect(x.run()).rejects.toMatchObject({ code })
  expect(x.requests).toHaveLength(1)
})

it('enforces the final prose size limit', async () => {
  const x = setup([() => toolResponse(JSON.stringify({ display_stream: '文'.repeat(200_001) }), { step: 100_000 })])
  await expect(x.run()).rejects.toMatchObject({ code: 'MODEL_OUTPUT_TOO_LARGE' })
})

it('preserves the frozen guide but replaces the tool context after overflow recovery', async () => {
  const x = setup([() => new Response('{"error":{"message":"maximum context length exceeded","code":"context_length_exceeded"}}', { status: 400 }),
    () => toolResponse('{"display_stream":"恢复后正文"}')], { recoverOverflow: vi.fn(async () => ({ systemPrompt: '压缩后系统', prompt: '压缩后的真实上下文' })) })
  expect((await x.run()).text).toBe('恢复后正文')
  expect(x.requests).toHaveLength(2)
  expect(x.requests[1]!.messages.slice(1)).toEqual(x.requests[0]!.messages.slice(1))
  expect(x.requests[1]!.messages[0].content).toContain('压缩后系统')
  expect(x.requests[1]!.tools[0].function.description).toContain('压缩后的真实上下文')
  expect(x.requests[1]!.tools[0].function.description).not.toContain(x.request.prompt)
})

it('rejects tool name collisions before sending a request', async () => {
  const x = setup([], { tools: [{ name: 'writer_display', label: 'Read', description: 'Existing tool', parameters: Type.Object({}), execute: vi.fn() }] })
  await expect(x.run()).rejects.toMatchObject({ code: 'WRITER_DELIVERY_CONFLICT' })
  expect(x.requests).toEqual([])
})

it('cancels a streamed delivery without reporting a successful result', async () => {
  const controller = new AbortController(), previews: string[] = []
  const x = setup([() => toolResponse('{"display_stream":"取消前已开始显示的草稿。"}')], {
    signal: controller.signal, onText: (text, final) => { previews.push(text); if (!final && text) controller.abort(new Error('cancel delivery')) },
  })
  await expect(x.run()).rejects.toThrow('cancel delivery')
  expect(previews.some(Boolean)).toBe(true)
})

it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)('sends the delivery schema and guide through the real %s adapter', async api => {
  const requests: Record<string, any>[] = []
  const models = new ModelRegistry([{ ...registration, api }], { env: () => 'test-key', fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return new Response('{"error":{"message":"capture-only"}}', { status: 400 })
  } })
  const preset = history(); preset.delivery!.toolName = 'deliver_reply'; preset.delivery!.fieldName = 'prose'
  await expect(runIsolated(models, { route, systemPrompt: 'Writer system', prompt: 'live-context-marker', images: [], tools: [], maxSteps: 1,
    signal: new AbortController().signal, initialHistory: preset })).rejects.toThrow()
  expect(requests).toHaveLength(1)
  const body = requests[0]!, tool = api === 'openai-completions' ? body.tools[0].function : body.tools[0]
  expect(tool.name).toBe('deliver_reply')
  expect(tool.description).toContain('live-context-marker')
  expect((tool.parameters ?? tool.input_schema).required).toEqual(['prose'])
  expect(JSON.stringify(body.messages ?? body.input)).not.toContain('live-context-marker')
})
