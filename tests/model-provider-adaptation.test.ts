import { expect, it } from 'vitest'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { Context } from '@earendil-works/pi-ai'
import { ModelRegistry, type ModelRegistration } from '../apps/server/src/runtime/models.ts'
import { checkModel, discoverModels } from '../apps/server/src/services/model-inspection.ts'
import { servicePresets } from '../apps/web/src/pages/settings/models/service-presets.ts'
import { anthropicResponse } from './anthropic-response.ts'

const user = { role: 'user' as const, content: 'synthetic-private-prompt', timestamp: 0 }
type Body = { messages?: { role: string; content: unknown; output_config?: { effort: string } }[]; [key: string]: unknown }
const efforts = (body: Body) => body.messages?.flatMap(message => message.output_config ? [message.output_config.effort] : []) ?? []
const base: ModelRegistration = { provider: 'connection-123', model: 'claude-opus-5', keyEnv: 'SYNTHETIC', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', temperature: .7 }
const route = { provider: base.provider, model: base.model }
const terminal = () => Response.json({ error: { type: 'synthetic_error', message: 'Synthetic terminal response' } }, { status: 400 })

it.each(['https://anthropic.test', 'https://anthropic.test/v1', 'https://anthropic.test/v1///', 'https://anthropic.test/gateway/v1/'])('uses one canonical endpoint for discovery and generation at %s', async baseUrl => {
  const requests: { method: string; path: string }[] = []
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ method: init?.method ?? '', path: new URL(String(url)).pathname })
    return init?.method === 'GET' ? Response.json({ data: [{ id: base.model }] }) : anthropicResponse()
  }
  const connection = { api: base.api, baseUrl }, registration = { ...base, ...connection }
  await discoverModels(connection, 'synthetic-key', fetcher, new AbortController().signal)
  expect(await checkModel(registration, 'synthetic-key', { fetch: fetcher }, new AbortController().signal)).toMatchObject({ status: 'passed' })
  const prefix = baseUrl.includes('gateway') ? '/gateway' : ''
  expect(requests).toEqual([{ method: 'GET', path: prefix + '/v1/models' }, { method: 'POST', path: prefix + '/v1/messages' }])
  expect(new ModelRegistry([registration]).registrations()[0]?.baseUrl).toBe(baseUrl)
})

it.each([
  base,
  { ...base, provider: 'anthropic', api: undefined },
  { provider: 'anthropic', model: base.model, keyEnv: 'SYNTHETIC', temperature: .7 },
])('retains all native compatibility fields for the same endpoint under $provider', async registration => {
  const bodies: Body[] = []
  const models = new ModelRegistry([registration], { env: () => 'synthetic-key', fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return anthropicResponse() } })
  const { model } = models.resolve(registration)
  expect(model.compat).toEqual(builtinModels().getModel('anthropic', base.model)!.compat)
  const result = await models.stream(model, { messages: [user] }, { reasoningSelection: 'provider-default' }).result()
  expect(result.stopReason).toBe('stop')
  expect(result).not.toHaveProperty('providerThinkingLevel')
  expect(bodies[0]).not.toHaveProperty('temperature')
  expect(bodies[0]).not.toHaveProperty('thinking')
  expect(bodies[0]).not.toHaveProperty('output_config')
  expect(efforts(bodies[0]!)).toEqual([])
})

it('does not carry a native compatibility dialect to a different endpoint or API', () => {
  for (const registration of [{ ...base, provider: 'anthropic', baseUrl: 'https://gateway.test/v1' }, { ...base, api: 'openai-completions' as const }]) {
    const models = new ModelRegistry([registration], { env: () => 'synthetic-key' })
    expect(models.resolve(registration).model.compat).toEqual({})
    expect(models.list()[0]?.thinkingLevels).toEqual(['provider-default'])
  }
})

it('keeps mapped current effort, persisted replay metadata and safe request evidence consistent across mode changes', async () => {
  const bodies: Body[] = [], evidence: Record<string, unknown>[] = []
  const models = new ModelRegistry([{ ...base, reasoningControl: { mode: 'effort', format: 'anthropic', levels: { low: 'max', high: 'high' }, off: true } }], {
    env: () => 'synthetic-private-key', fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return anthropicResponse() },
  })
  const { model } = models.resolve(route), original = structuredClone(model), context: Context = { messages: [user] }
  const invoke = (reasoningSelection: string) => models.stream(model, context, { reasoningSelection, onRequestParameters: params => evidence.push(params) }).result()
  const first = await invoke('low')
  expect(first).toMatchObject({ stopReason: 'stop', providerThinkingLevel: 'max' })
  context.messages.push(first, { ...user, content: 'synthetic-followup' })
  expect(await invoke('high')).toMatchObject({ stopReason: 'stop', providerThinkingLevel: 'high' })
  expect(efforts(bodies[0]!)).toEqual(['max'])
  expect(efforts(bodies[1]!)).toEqual(['max', 'high'])
  for (const body of bodies) expect(body).toMatchObject({ output_config: { effort: 'high' }, thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } } })
  expect(evidence[1]?.messages).toEqual(bodies[1]!.messages!.flatMap((message, index) => message.output_config ? [{ index, output_config: message.output_config }] : []))
  expect(await invoke('provider-default')).not.toHaveProperty('providerThinkingLevel')
  expect(bodies[2]).not.toHaveProperty('thinking')
  expect(bodies[2]).not.toHaveProperty('output_config')
  expect(await invoke('off')).not.toHaveProperty('providerThinkingLevel')
  expect(bodies[3]).toMatchObject({ thinking: { type: 'disabled' } })
  expect(bodies[3]).not.toHaveProperty('output_config')
  expect(efforts(bodies[2]!)).toEqual([]); expect(efforts(bodies[3]!)).toEqual([])
  expect(JSON.stringify(evidence)).not.toMatch(/synthetic-private|synthetic-followup|合成回复/)
  expect(model).toEqual(original)
})

it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)('enforces the app cap for ordinary, auxiliary and connection-test %s requests', async api => {
  const bodies: Body[] = [], registration = { ...base, model: 'synthetic', api, baseUrl: 'https://model.test/v1', outputTokens: 500 }
  const fetcher: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return terminal() }
  const models = new ModelRegistry([registration], { env: () => 'synthetic-key', fetch: fetcher })
  const { model } = models.resolve(registration)
  for (const maxTokens of [undefined, 4096, 256]) {
    const result = await models.stream(model, { messages: [user] }, { maxTokens, maxRetries: 0 }).result()
    expect(result.stopReason).toBe('error')
  }
  expect(await checkModel(registration, 'synthetic-key', { fetch: fetcher }, new AbortController().signal)).toMatchObject({ status: 'failed' })
  const field = api === 'anthropic-messages' ? 'max_tokens' : api === 'openai-responses' ? 'max_output_tokens' : 'max_completion_tokens'
  expect(bodies.map(body => body[field])).toEqual([500, 500, 256, 500])
  expect(models.outputBudget(registration, 4096)).toBe(500)
  for (const maxTokens of [0, -1, NaN, Infinity, 1.5]) expect(() => models.stream(model, { messages: [user] }, { maxTokens })).toThrow('调用输出上限')
  expect(bodies).toHaveLength(4)
})

it.each([false, true])('uses exact Qwen effort support over connection toggle hints (legacy: %s)', async legacy => {
  const native = builtinModels().getModel('qwen-token-plan-cn', 'qwen3.8-max')!, bodies: Body[] = []
  const compat = { ...servicePresets.find(preset => preset.id === 'bailian')!.compat, ...(legacy ? { supportsReasoningEffort: false } : {}) }
  const registration = { ...base, model: native.id, api: 'openai-completions' as const, baseUrl: native.baseUrl, compat }
  const models = new ModelRegistry([registration], { env: () => 'synthetic-key', fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return terminal() } })
  expect(models.list()[0]?.thinkingLevels).toEqual(['provider-default', 'low', 'medium', 'xhigh'])
  for (const reasoningEffort of ['off', 'high', 'max', 'enabled']) expect(() => models.resolve({ ...registration, reasoningEffort })).toThrow('思考强度')
  const { model } = models.resolve(registration)
  for (const reasoningSelection of ['low', 'xhigh']) await models.stream(model, { messages: [user] }, { reasoningSelection, maxRetries: 0 }).result()
  expect(bodies.map(body => [body.enable_thinking, body.reasoning_effort])).toEqual([[true, 'low'], [true, 'xhigh']])
})

it('does not invent off for a toggle hint when provider metadata explicitly forbids it', () => {
  const registration = { ...base, model: 'private-qwen', api: 'openai-completions' as const, compat: { thinkingFormat: 'qwen' as const, supportsReasoningEffort: false } }
  const models = new ModelRegistry([registration], { metadata: () => ({ reasoning: true, thinkingLevelMap: { off: null } }) })
  expect(models.list()[0]?.thinkingLevels).toEqual(['provider-default', 'enabled'])
})
