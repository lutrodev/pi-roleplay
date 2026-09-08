import { expect, it } from 'vitest'
import { ModelRegistry, type ModelRegistration } from '../apps/server/src/runtime/models.ts'
import { runIsolated } from '../apps/server/src/runtime/isolated.ts'
import { freshModel } from '../apps/web/src/pages/settings/models/catalog.ts'

const connection = { api: 'openai-completions' as const, baseUrl: 'https://model.test/v1' }
const registration = (model: string, overrides: Partial<ModelRegistration> = {}): ModelRegistration => ({
  ...freshModel(connection, model), provider: 'provider-synthetic', keyEnv: 'SYNTHETIC', ...overrides,
})
const registry = (...models: ModelRegistration[]) => new ModelRegistry(models, { env: () => 'synthetic-test-key' })
const route = (model: string) => ({ provider: 'provider-synthetic', model })

it('automatically recognizes exact catalog models behind custom connection IDs and starts reasoning enabled', () => {
  const models = registry(registration('gpt-5.6-sol'), registration('gpt-5-pro'), registration('deepseek-v4-pro'), registration('gpt-4.1'))
  expect(models.list()[0]).toMatchObject({ reasoningSource: 'catalog', thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], defaultThinkingLevel: 'medium' })
  expect(models.resolve(route('gpt-5.6-sol')).thinkingLevel).toBe('medium')
  expect(models.resolve(route('gpt-5-pro')).thinkingLevel).toBe('high')
  expect(models.list()[1]?.thinkingLevels).toEqual(['high'])
  expect(models.resolve(route('deepseek-v4-pro'))).toMatchObject({ thinkingLevel: 'high', model: { compat: { thinkingFormat: 'deepseek' } } })
  expect(models.list()[3]).toMatchObject({ thinkingLevels: ['off'], defaultThinkingLevel: 'off' })
  expect(models.registrations()[0]?.reasoning).toBeUndefined()
})

it('recognizes the documented Astra entry without inventing off, minimal, ultra, or alias support', () => {
  const models = registry(registration('gpt-6-astra'), registration('my-gpt-6-astra'), registration('gpt-6-astra', { provider: 'other', api: 'anthropic-messages' }))
  expect(models.list()[0]).toMatchObject({ thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultThinkingLevel: 'medium', reasoningSource: 'catalog' })
  expect(models.list()[1]).toMatchObject({ thinkingLevels: ['off'], reasoningSource: 'unknown' })
  expect(models.list()[2]).toMatchObject({ thinkingLevels: ['off'], reasoningSource: 'unknown' })
  for (const reasoningEffort of ['off', 'minimal', 'ultra']) expect(() => models.resolve({ ...route('gpt-6-astra'), reasoningEffort })).toThrow('思考强度')
})

it('preserves explicit capability choices and leaves unrecognized models observable and manually configurable', () => {
  const models = registry(registration('gpt-5.6-sol', { reasoning: false }), registration('private-alias', { reasoning: true }), registration('unknown-reasoning-model'))
  expect(models.list().map(model => model.reasoningSource)).toEqual(['manual', 'manual', 'unknown'])
  expect(models.resolve(route('gpt-5.6-sol')).thinkingLevel).toBe('off')
  expect(models.resolve(route('private-alias')).thinkingLevel).toBe('medium')
  expect(() => models.resolve({ ...route('unknown-reasoning-model'), reasoningEffort: 'high' })).toThrow('思考强度')
  const reopened = registry(...models.registrations())
  expect(reopened.registrations().map(model => model.reasoning)).toEqual([false, true, undefined])
})

it('sends the selected/default effort and explicit off through the actual Pi Agent and Chat Completions adapter', async () => {
  const bodies: Record<string, unknown>[] = []
  const models = new ModelRegistry([registration('gpt-5.6-sol'), registration('deepseek-v4-pro'), registration('gpt-6-astra')], {
    env: () => 'synthetic-test-key', fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '完成。' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  for (const selected of [route('gpt-5.6-sol'), { ...route('gpt-5.6-sol'), reasoningEffort: 'max' }, { ...route('gpt-5.6-sol'), reasoningEffort: 'off' }, route('deepseek-v4-pro'), route('gpt-6-astra')]) {
    await runIsolated(models, { route: selected, systemPrompt: '合成测试', prompt: '继续', images: [], tools: [], maxSteps: 1, signal: new AbortController().signal })
  }
  expect(bodies.map(body => body.reasoning_effort)).toEqual(['medium', 'max', 'none', 'high', 'medium'])
  expect(bodies[3]).toMatchObject({ thinking: { type: 'enabled' } })
})
