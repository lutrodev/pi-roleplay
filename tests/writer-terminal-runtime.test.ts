import { afterEach, expect, it, vi } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { terminalWriterHistory } from '../packages/rp-core/src/agents/writer-history-example.ts'
import { writerHistoryIssues } from '../packages/rp-core/src/agents/writer-history.ts'
import { visitingStory } from '../packages/rp-core/src/agents/writer-terminal-story.ts'
import { terminalInput, terminalShellPrompt } from '../packages/rp-core/src/agents/writer-terminal.ts'
import { WriterHistoryService } from '../apps/server/src/services/writer-history-service.ts'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { ModelRegistry, type ModelRegistration } from '../apps/server/src/runtime/models.ts'
import { runIsolated, type IsolatedRequest } from '../apps/server/src/runtime/isolated.ts'
import { fixture, message, profile } from './helpers.ts'
import { historyTextResponse } from './writer-history-fixture.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
const route = { provider: 'test', model: 'writer' }
const registration: ModelRegistration = { ...route, keyEnv: 'SYNTHETIC', api: 'openai-completions', baseUrl: 'https://terminal.test/v1',
  contextWindow: 100_000, maxTokens: 8000, input: ['text', 'image'] }
const prose = 'user@linux:~$ cd Documents\nuser@linux:~/Documents$ cat chapter_01.txt\n“{{user}}，信号恢复了。”\n🌄\\尾声'
function history() {
  const x = fixture(); cleanup.push(x.close)
  const service = new WriterHistoryService(x.assets), config = terminalWriterHistory(); config.enabled = true
  expect(writerHistoryIssues(config)).toEqual([])
  service.update(1, config)
  return { service, config, frozen: service.capture()! }
}
function response(name: string, raw = JSON.stringify({ display_stream: prose }), finish = 'tool_calls', extra?: string) {
  const frame = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  let data = frame({ role: 'assistant', content: '不应混入交付正文', tool_calls: [{ index: 0, id: 'carrier', type: 'function', function: { name, arguments: '' } }] })
  for (let i = 0; i < raw.length; i += 7) data += frame({ tool_calls: [{ index: 0, function: { arguments: raw.slice(i, i + 7) } }] })
  if (extra) data += frame({ tool_calls: [{ index: 1, id: 'second-call', type: 'function', function: { name: extra, arguments: extra === name ? raw : '{}' } }] })
  return new Response(data + frame({}, finish) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}
function setup(reply: (name: string, index: number) => Response = name => response(name), overrides: Partial<IsolatedRequest> = {}, api = registration.api) {
  const requests: Record<string, any>[] = [], frozen = overrides.initialHistory ?? history().frozen
  const models = new ModelRegistry([{ ...registration, api }], { env: () => 'synthetic-key', fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return reply(frozen.delivery!.toolName, requests.length - 1)
  } })
  const request: IsolatedRequest = { route, systemPrompt: '本轮真实 Writer 规则', prompt: '旧的 JSONL 提示不能混入消息',
    terminalPrompt: terminalInput('本轮真实输入', 'chapter_01.txt'), images: [], tools: [], maxSteps: 6,
    signal: new AbortController().signal, initialHistory: frozen, ...overrides }
  return { requests, request, run: () => runIsolated(models, request) }
}

it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)('rebuilds the actual %s HTTP request into the four-message archive protocol', async api => {
  const x = fixture(); cleanup.push(x.close)
  const card = x.assets.create('character', { name: '秦禾', description: '真实角色资料' })
  const style = x.assets.create('writingStyle', { name: '细节', content: '真实写作风格' })
  const config = profile(); config.resources.card = { id: card.id }; config.resources.writingStyles = [{ id: style.id }]
  const story = x.stories.create('验收', config), service = new StoryService(x.stories, x.assets, x.files)
  const old = message('user', '历史原话【LAST_USER_INPUT】'), previous = message('assistant', '历史正文', { kind: 'narrative' })
  for (const item of [old, previous, message('assistant', '仅作讨论的历史')]) x.stories.append(story.id, { type: 'message.added', data: { message: item } })
  const run = service.send(story.id, 'send', [{ text: '当前输入甲', attachmentIds: [] }, { text: '当前输入乙', attachmentIds: [] }]).run
  const context = new ContextService(x.stories, x.assets).preview(story.id, run.id, route)
  const test = setup(() => new Response('{"error":{"message":"capture-only"}}', { status: 400 }), {
    terminalPrompt: context.writerTerminalPrompt,
    images: [{ type: 'image', mimeType: 'image/png', data: 'c3ludGhldGlj' }],
  }, api)
  await expect(test.run()).rejects.toMatchObject({ code: 'MODEL_REQUEST_FAILED' })
  expect(test.requests).toHaveLength(1)
  const body = test.requests[0]!, tool = api === 'openai-completions' ? body.tools[0].function : body.tools[0]
  const messages = body.messages ?? body.input, schema = tool.parameters ?? tool.input_schema
  const guide = api === 'anthropic-messages' ? messages : messages.filter((item: any) => item.role !== 'system' && item.role !== 'developer')
  expect(guide.map((item: any) => item.role)).toEqual(['user', 'assistant', 'user'])
  expect(JSON.stringify(body.system ?? messages[0])).toContain('interactive Linux terminal emulator')
  expect(JSON.stringify(messages)).not.toContain('当前输入甲')
  expect(JSON.stringify(messages)).not.toContain(visitingStory.firstInput)
  expect(JSON.stringify(messages)).not.toContain('本轮真实 Writer 规则')
  expect(JSON.stringify(messages)).toContain(tool.name)
  expect(JSON.stringify(messages)).not.toMatch(/%TOOL_NAME%|%OUTPUT_FIELD%|%SESSION_ID%/)
  expect(tool.name).toMatch(/^dispatch_chapter_[a-f0-9]{16}$/)
  expect(tool.description).toContain('cat writer_rules.txt\n本轮真实 Writer 规则')
  expect(tool.description).toContain(visitingStory.firstInput)
  const example = terminalWriterHistory()
  expect(tool.description.match(/\[example tool: bash\]/g)).toHaveLength(20)
  expect(tool.description.match(/\[example tool: dispatch_chapter_example\]/g)).toHaveLength(2)
  for (const round of example.rounds) for (const step of round.steps) {
    expect(tool.description).toContain(`arguments = ${step.argumentsJson}`)
    expect(tool.description).toContain(`result = ${step.resultJson}`)
  }
  expect(tool.description).toContain(JSON.stringify(visitingStory.firstChapter).slice(1, -1))
  expect(tool.description).toContain(JSON.stringify(visitingStory.secondChapter).slice(1, -1))
  expect(body.tools.some((entry: any) => (entry.function ?? entry).name === 'bash')).toBe(false)
  expect(tool.description).toContain('真实角色资料')
  expect(tool.description).toContain('真实写作风格')
  expect(tool.description).toContain(`cat history_1_${old.id}_preview.txt\n历史原话【LAST_USER_INPUT】`)
  expect(tool.description).toContain('[system@stream-output] kind=narrative:\n历史正文')
  expect(tool.description).toContain('[system@stream-output] kind=discussion:\n仅作讨论的历史')
  expect(tool.description).toContain('cat current_input_1_preview.txt\n当前输入甲')
  expect(tool.description).toContain(`cat chapter_01_preview.txt\n当前输入乙\n${terminalShellPrompt()} cat chapter_01.txt`)
  expect(tool.description.match(/当前输入[甲乙]/g)).toHaveLength(2)
  expect(schema.required).toEqual(['display_stream'])
  expect(schema.properties.display_stream.description).toContain('终端完整显示流')
  expect(body.tool_choice).toEqual(api === 'anthropic-messages' ? { type: 'auto' } : 'auto')
  expect(JSON.stringify(guide.at(-1))).toMatch(/image_url|input_image|"image"/)
})

it('streams decoded arguments and normalizes the carrier to a text/stop response without executing it', async () => {
  const messages: any[] = [], events: string[] = [], previews: [string, boolean][] = []
  const x = setup(undefined, { identities: { userName: '乔木' }, onText: (text, final) => previews.push([text, final]),
    onMessage: message => messages.push(message), onEvent: event => { if (event.type === 'tool_execution_start') events.push(event.toolName) } })
  const text = prose.replace('{{user}}', '乔木')
  expect((await x.run()).text).toBe(text)
  expect(previews.some(([value, final]) => !final && value.length > 0 && value.length < text.length)).toBe(true)
  expect(previews.at(-1)).toEqual([text, true])
  expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' })
  expect(events).toEqual([])
  expect(JSON.stringify(messages)).not.toContain('不应混入交付正文')
})

it('streams a complete expanded terminal session without dropping its command log or chapter ending', async () => {
  const full = terminalWriterHistory().rounds[0]!.assistant, previews: [string, boolean][] = []
  const x = setup(name => response(name, JSON.stringify({ display_stream: full })), {
    onText: (text, final) => previews.push([text, final]),
  })
  expect((await x.run()).text).toBe(full)
  expect(previews.some(([text, final]) => !final && text.length > 0 && text.length < full.length)).toBe(true)
  expect(previews.at(-1)).toEqual([full, true])
  expect(full.endsWith(visitingStory.firstChapter)).toBe(true)
})

it.each([false, true])('keeps real read-only calls executable (same response: %s)', async mixed => {
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '附件实读结果' }], details: {} }))
  const x = setup((name, index) => mixed ? response(name, undefined, 'tool_calls', 'read')
    : index === 0 ? response('read', '{}') : response(name), { tools: [{ name: 'read', label: 'Read', description: 'Read actual input', parameters: Type.Object({}), execute }] })
  expect((await x.run()).text).toBe(prose)
  expect(execute).toHaveBeenCalledOnce()
  expect(x.requests).toHaveLength(mixed ? 1 : 2)
  if (!mixed) {
    expect(JSON.stringify(x.requests[1]!.messages)).toContain('附件实读结果')
    expect(x.requests[1]!.tools).toEqual(x.requests[0]!.tools)
  }
})

it.each([
  ['plain response', () => historyTextResponse('不能静默降级'), 'WRITER_DELIVERY_INVALID'],
  ['truncated JSON', (name: string) => response(name, '{"display_stream":"未结束'), 'WRITER_DELIVERY_INVALID'],
  ['repaired JSON', (name: string) => response(name, '{"display_stream":"原始 JSON 不合法",}'), 'WRITER_DELIVERY_INVALID'],
  ['empty field', (name: string) => response(name, '{"display_stream":" "}'), 'WRITER_DELIVERY_INVALID'],
  ['extra field', (name: string) => response(name, '{"display_stream":"文","x":1}'), 'WRITER_DELIVERY_INVALID'],
  ['duplicate carrier', (name: string) => response(name, undefined, 'tool_calls', name), 'WRITER_DELIVERY_INVALID'],
  ['length', (name: string) => response(name, undefined, 'length'), 'MODEL_OUTPUT_TRUNCATED'],
  ['filter', (name: string) => response(name, undefined, 'content_filter'), 'MODEL_CONTENT_FILTER'],
] as const)('fails explicitly for %s, without executing a synthetic tool', async (_label, reply, code) => {
  const events: string[] = [], x = setup(reply, { maxSteps: 1, onEvent: event => events.push(event.type) })
  await expect(x.run()).rejects.toMatchObject({ code })
  expect(events).not.toContain('tool_execution_start')
})

it('freezes the session and examples across compaction while replacing only actual context', async () => {
  const first = history(), old = structuredClone(first.frozen)
  first.config.rounds[0]!.user = '修改后的示例'; first.service.update(2, first.config)
  const next = first.service.capture()!
  expect(next.delivery!.toolName).not.toBe(old.delivery!.toolName)
  expect(next.terminalExamples).toContain('修改后的示例')
  const x = setup((name, index) => index === 0 ? new Response('{"error":{"message":"maximum context length exceeded","code":"context_length_exceeded"}}', { status: 400 }) : response(name), {
    initialHistory: old, recoverOverflow: async () => ({ systemPrompt: '新规则', prompt: '新普通提示', terminalPrompt: terminalInput('压缩后的输入', 'chapter_01.txt') }),
  })
  await x.run()
  expect(x.requests[0]!.messages).toEqual(x.requests[1]!.messages)
  expect(x.requests[0]!.tools[0].function.name).toBe(x.requests[1]!.tools[0].function.name)
  expect(x.requests[1]!.tools[0].function.description).toContain('压缩后的输入')
  expect(x.requests[1]!.tools[0].function.description).toContain('cat writer_rules.txt\n新规则')
  expect(x.requests[1]!.tools[0].function.description).not.toContain('本轮真实输入')
  expect(x.requests[1]!.tools[0].function.description).not.toContain('修改后的示例')
  expect(old.metadata).toMatchObject({ messageCount: 2, toolCallCount: 0, guideMessageCount: 2 })
  expect(first.frozen).toEqual(old)
})

it('cancels an incomplete delivery and rejects a missing structured archive before network access', async () => {
  const controller = new AbortController()
  const x = setup(undefined, { signal: controller.signal, onText: (text, final) => { if (text && !final) controller.abort(new Error('cancel terminal')) } })
  await expect(x.run()).rejects.toThrow('cancel terminal')
  const missing = setup(undefined, { terminalPrompt: undefined })
  await expect(missing.run()).rejects.toMatchObject({ code: 'WRITER_ARCHIVE_MISSING' })
  expect(missing.requests).toEqual([])
})
