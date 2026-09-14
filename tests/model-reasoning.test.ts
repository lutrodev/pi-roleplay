import { expect, it, vi } from 'vitest'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { ModelRegistry, type ModelRegistration } from '../apps/server/src/runtime/models.ts'
import { runIsolated } from '../apps/server/src/runtime/isolated.ts'
import { parseModelConfig } from '../apps/server/src/config.ts'
import { profile } from './helpers.ts'
import { resolveModelSelection } from '../packages/rp-core/src/agents/catalog.ts'
import type { ReasoningControlConfig } from '../packages/protocol/src/reasoning.ts'

const base: ModelRegistration = { provider: 'synthetic', model: 'private-alias', keyEnv: 'SYNTHETIC', api: 'openai-completions', baseUrl: 'https://model.test/v1' }
const route = { provider: base.provider, model: base.model }
const effort: ReasoningControlConfig = { mode: 'effort', format: 'openai', levels: { low: 'low', high: 'high' }, off: 'none' }
const registry = (...models: ModelRegistration[]) => new ModelRegistry(models, { env: () => 'synthetic-key' })
const completion = () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '完成。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })

it('separates capability evidence from channel controls; unknown gateways get no invented effort or off', () => {
  const models = registry({ ...base, model: 'gpt-5.6-sol' }, { ...base, reasoning: true }, { ...base, model: 'cline-pass/deepseek-v4-flash', reasoning: true })
  for (const model of models.list()) expect(model).toMatchObject({ thinkingLevels: ['provider-default'], defaultThinkingLevel: 'provider-default' })
  expect(models.list()[0]?.reasoningSource).toBe('catalog')
  for (const reasoningEffort of ['off', 'medium', 'high']) expect(() => models.resolve({ ...route, reasoningEffort })).toThrow('思考强度')
  expect(models.resolve(route).reasoning).toMatchObject({ effective: 'provider-default', mode: 'provider' })
})

it('uses exact catalog and endpoint evidence, service defaults, and distinct effort values', () => {
  const models = registry({ ...base, model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1' },
    { ...base, model: 'gpt-5-pro', baseUrl: 'https://api.openai.com/v1' },
    { ...base, model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com' },
    { ...base, model: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' })
  expect(models.list()[0]?.thinkingLevels).toEqual(['provider-default', 'off', 'low', 'medium', 'high', 'xhigh', 'max'])
  expect(models.list()[1]?.thinkingLevels).toEqual(['provider-default', 'high'])
  expect(models.list()[2]?.thinkingLevels).toEqual(['provider-default', 'off', 'high', 'max'])
  expect(models.list()[3]?.thinkingLevels).not.toContain('minimal')
})

it('represents Qwen toggle-only compatibility with a single enabled choice', () => {
  const models = registry({ ...base, reasoning: true, compat: { thinkingFormat: 'qwen', supportsReasoningEffort: false } })
  expect(models.list()[0]?.thinkingLevels).toEqual(['provider-default', 'off', 'enabled'])
  expect(() => models.resolve({ ...route, reasoningEffort: 'high' })).toThrow('思考强度')
  const disabled = registry({ ...base, model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1', compat: { supportsReasoningEffort: false } })
  expect(disabled.list()[0]?.thinkingLevels).toEqual(['provider-default'])
})

it('preserves default calls for built-in Pi protocols without assigning them an OpenAI dialect', () => {
  for (const api of ['google-generative-ai', 'google-vertex', 'bedrock-converse-stream', 'mistral-conversations', 'openai-codex-responses']) {
    const model = builtinModels().getModels().find(model => model.api === api && model.reasoning)!
    const models = registry({ provider: model.provider, model: model.id, keyEnv: 'SYNTHETIC' })
    expect(models.list()[0]?.thinkingLevels).toEqual(['provider-default'])
    expect(models.resolve({ provider: model.provider, model: model.id }).reasoning.effective).toBe('provider-default')
  }
})

it('omits the SDK-injected disabled thinking config on native Google default requests', async () => {
  const native = builtinModels().getModel('google', 'gemini-2.5-flash')!, bodies: Record<string, unknown>[] = []
  // Pi's Google adapter rejects per-request fetch overrides; stub the SDK's global transport.
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ error: { code: 400, message: 'Synthetic terminal response', status: 'INVALID_ARGUMENT' } }, { status: 400 })
  })
  try {
    const models = new ModelRegistry([{ provider: native.provider, model: native.id, keyEnv: 'SYNTHETIC' }], { env: () => 'synthetic-key' })
    const { model } = models.resolve({ provider: native.provider, model: native.id })
    const result = await models.stream(model, { messages: [{ role: 'user', content: 'test', timestamp: 0 }] }, { maxRetries: 0 }).result()
    expect(result.stopReason).toBe('error')
    expect(bodies, result.errorMessage).toHaveLength(1)
    expect(bodies[0]?.generationConfig).not.toHaveProperty('thinkingConfig')
  } finally { vi.unstubAllGlobals() }
})

it.each([
  ['OpenAI', { mode: 'effort', format: 'openai', levels: { high: 'high', max: 'max' }, off: 'none' }, ['high', 'off', 'provider-default', 'max'], [{ reasoning_effort: 'high' }, { reasoning_effort: 'none' }, {}, { reasoning_effort: 'max' }]],
  ['DeepSeek', { mode: 'effort', format: 'deepseek', levels: { high: 'high', max: 'max' }, off: true }, ['high', 'off', 'provider-default', 'max'], [{ thinking: { type: 'enabled' }, reasoning_effort: 'high' }, { thinking: { type: 'disabled' } }, {}, { thinking: { type: 'enabled' }, reasoning_effort: 'max' }]],
  ['Qwen', { mode: 'toggle', format: 'qwen', off: true }, ['enabled', 'off', 'provider-default'], [{ enable_thinking: true }, { enable_thinking: false }, {}]],
  ['GLM', { mode: 'toggle', format: 'zai', off: true }, ['enabled', 'off', 'provider-default'], [{ thinking: { type: 'enabled', clear_thinking: false } }, { thinking: { type: 'disabled' } }, {}]],
  ['OpenRouter', { mode: 'effort', format: 'openrouter', levels: { low: 'low', high: 'high' }, off: true }, ['low', 'off', 'provider-default'], [{ reasoning: { effort: 'low' } }, { reasoning: { effort: 'none' } }, {}]],
] as const)('serializes %s choices through the actual Pi Agent and SDK', async (_name, control, choices, expected) => {
  const bodies: Record<string, unknown>[] = []
  const models = new ModelRegistry([{ ...base, reasoningControl: control, compat: { thinkingFormat: control.format, supportsReasoningEffort: control.mode === 'effort' } }], { env: () => 'synthetic-key', fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return completion() } })
  for (const reasoningEffort of choices) await runIsolated(models, { route: { ...route, reasoningEffort }, systemPrompt: '合成测试', prompt: '继续', images: [], tools: [], maxSteps: 1, signal: new AbortController().signal })
  expect(bodies.map(body => Object.fromEntries(Object.entries(body).filter(([key]) => ['reasoning', 'reasoning_effort', 'thinking', 'enable_thinking'].includes(key))))).toEqual(expected)
})

it.each([
  ['openai-responses', { mode: 'effort', format: 'openai-responses', levels: { high: 'high' }, off: 'none' }, 'high', { reasoning: { effort: 'high', summary: 'auto' } }],
  ['openai-responses', { mode: 'effort', format: 'openai-responses', levels: { high: 'high' }, off: 'none' }, 'off', { reasoning: { effort: 'none' } }],
  ['openai-responses', { mode: 'effort', format: 'openai-responses', levels: { high: 'high' }, off: 'none' }, 'provider-default', { reasoning: { summary: 'auto' } }],
  ['anthropic-messages', { mode: 'effort', format: 'anthropic', levels: { high: 'high' }, off: true }, 'high', { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } }],
  ['anthropic-messages', { mode: 'budget', format: 'anthropic', levels: { low: 2048 }, off: true }, 'low', { thinking: { type: 'enabled', budget_tokens: 2048, display: 'summarized' } }],
  ['anthropic-messages', { mode: 'budget', format: 'anthropic', levels: { low: 2048 }, off: true }, 'off', { thinking: { type: 'disabled' } }],
  ['anthropic-messages', { mode: 'budget', format: 'anthropic', levels: { low: 2048 }, off: true }, 'provider-default', {}],
] as const)('sends the %s HTTP payload for %s / %s', async (api, control, reasoningEffort, expected) => {
  const bodies: Record<string, unknown>[] = []
  const models = new ModelRegistry([{ ...base, api, reasoningControl: control, outputTokens: 4096 }], { env: () => 'synthetic-key', fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    // Assert the real HTTP request; return an explicit failure without simulating successful generation.
    return Response.json({ error: { type: 'synthetic_error', message: 'Synthetic terminal response' } }, { status: 400 })
  } })
  const { model } = models.resolve({ ...route, reasoningEffort })
  const result = await models.stream(model, { messages: [{ role: 'user', content: '合成测试', timestamp: 0 }] }, { reasoningSelection: reasoningEffort, maxRetries: 0 }).result()
  expect(result.stopReason).toBe('error'); expect(bodies).toHaveLength(1)
  expect(Object.fromEntries(Object.entries(bodies[0]!).filter(([key]) => ['reasoning', 'thinking', 'output_config'].includes(key)))).toEqual(expected)
  expect(bodies[0]?.[api === 'anthropic-messages' ? 'max_tokens' : 'max_output_tokens']).toBe(4096)
})

it('rejects unaffordable thinking budgets before network access instead of silently clamping', () => {
  let calls = 0
  const models = new ModelRegistry([{ ...base, api: 'anthropic-messages', outputTokens: 2048, reasoningControl: { mode: 'budget', format: 'anthropic', levels: { high: 4096 } } }], { env: () => 'synthetic-key', fetch: async () => { calls++; return completion() } })
  expect(() => models.resolve({ ...route, reasoningEffort: 'high' })).toThrow('1024')
  const { model } = models.resolve(route)
  expect(() => models.stream(model, { messages: [{ role: 'user', content: 'test', timestamp: 0 }] }, { reasoningSelection: 'high' })).toThrow('1024')
  expect(calls).toBe(0)
})

it('keeps a fixed same-model Writer independent, explicit inheritance, and service default intact through Agent', async () => {
  const bodies: Record<string, unknown>[] = [], models = new ModelRegistry([{ ...base, reasoningControl: effort, defaultReasoningEffort: 'low' }], { env: () => 'synthetic-key', fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return completion() } })
  const main = { ...route, reasoningEffort: 'high' }, p = profile()
  p.runtime.writerRoute = { kind: 'fixed', ...route }
  const routes = models.routes(p, { main })
  const selections = [routes.main, routes.writer, resolveModelSelection({ kind: 'inherit' }, main), resolveModelSelection({ kind: 'inherit', reasoningEffort: 'provider-default' }, main)]
  for (const selected of selections) await runIsolated(models, { route: selected, systemPrompt: 'test', prompt: 'test', images: [], tools: [], maxSteps: 1, signal: new AbortController().signal })
  expect(bodies.map(body => body.reasoning_effort)).toEqual(['high', 'low', 'high', undefined])
  expect(registry(...models.registrations()).resolve(routes.writer).reasoning).toMatchObject({ effective: 'low', source: 'model-default' })
})

it('validates controls, duplicate wire values, protocol matching and defaults', () => {
  for (const reasoningControl of [null, { mode: 'provider', off: true }, { ...effort, levels: {} }, { ...effort, off: true }, { ...effort, levels: { low: 'high', high: 'high' } }]) {
    expect(() => parseModelConfig({ models: [{ ...base, reasoningControl }] })).toThrow('思考')
  }
  expect(() => registry({ ...base, reasoningControl: effort, reasoning: false })).toThrow('思考能力')
  expect(() => registry({ ...base, api: 'anthropic-messages', reasoningControl: effort })).toThrow('协议')
  expect(() => registry({ ...base, api: 'anthropic-messages', reasoningControl: { mode: 'effort', format: 'anthropic', levels: { high: 'custom-invalid' } } })).toThrow('Anthropic 思考强度参数')
  expect(() => registry({ ...base, reasoningControl: effort, defaultReasoningEffort: 'medium' })).toThrow('默认思考')
})
