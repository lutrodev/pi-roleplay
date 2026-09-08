import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { ModelCatalogService } from '../apps/server/src/services/model-catalog-service.ts'
import { discoverModels, validateConnection } from '../apps/server/src/services/model-inspection.ts'
import { freshModel } from '../apps/web/src/pages/settings/models/catalog.ts'
import { customService, matchingServices, serviceForConnection, servicePresets } from '../apps/web/src/pages/settings/models/service-presets.ts'
import { fixture } from './helpers.ts'

it('finds services by Chinese names, aliases and model families without making an unmatched service a preset', () => {
  expect(matchingServices('  google GEMINI ').map(service => service.id)).toEqual(['google'])
  expect(matchingServices('Claude').map(service => service.id)).toEqual(['anthropic'])
  expect(matchingServices('通义千问').map(service => service.id)).toEqual(['bailian'])
  expect(matchingServices('月之暗面').map(service => service.id)).toEqual(['moonshot'])
  expect(matchingServices('siliconflow').map(service => service.id)).toEqual(['siliconflow'])
  expect(matchingServices('clinepass')).toEqual([])
  expect(matchingServices('unknown service')).toEqual([])
  expect(matchingServices('').filter(service => service.common).map(service => service.id)).toEqual(['openai', 'anthropic', 'google', 'openrouter', 'moonshot', 'deepseek'])
  expect(new Set(servicePresets.map(service => service.id)).size).toBe(servicePresets.length)
  expect(customService.connection.baseUrl).toBe('')
})

it.each(servicePresets)('routes $label discovery and generation through its declared protocol and endpoint', async service => {
  const connection = validateConnection(service.connection)
  const discovery = await discoverModels(connection, 'synthetic-key', async (url, options) => {
    const anthropic = connection.api === 'anthropic-messages'
    const expected = new URL(connection.baseUrl + (anthropic ? '/v1/models' : '/models'))
    if (anthropic) expected.searchParams.set('limit', '1000')
    expect(String(url)).toBe(expected.href)
    expect(new Headers(options?.headers).get(anthropic ? 'x-api-key' : 'authorization')).toBe(anthropic ? 'synthetic-key' : 'Bearer synthetic-key')
    return Response.json({ data: [{ id: 'synthetic-model' }] })
  }, new AbortController().signal)
  expect(discovery.models.map(model => model.model)).toEqual(['synthetic-model'])
  let request: { url: string; headers: Headers; body: Record<string, unknown> } | undefined
  const route = { provider: 'provider-synthetic', model: 'synthetic-model' }
  const registry = new ModelRegistry([{ ...freshModel(connection, route.model), ...route, keyEnv: 'TEST_KEY' }], {
    env: () => 'synthetic-key', fetch: async (url, init) => {
      request = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }
      // Reject locally after inspecting the actual Pi request. No live provider is called.
      return Response.json({ error: { message: 'Synthetic transport stop' } }, { status: 400 })
    },
  })
  const resolved = registry.resolve(route)
  const result = await registry.stream(resolved.model, { systemPrompt: 'Test', messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] }, { maxRetries: 0 }).result()
  expect(result.stopReason).toBe('error')
  const anthropic = connection.api === 'anthropic-messages'
  const requestUrl = new URL(request!.url)
  expect(requestUrl.origin + requestUrl.pathname).toBe(connection.baseUrl + (anthropic ? '/v1/messages' : '/chat/completions'))
  expect(request?.headers.get(anthropic ? 'x-api-key' : 'authorization')).toBe(anthropic ? 'synthetic-key' : 'Bearer synthetic-key')
  expect(request?.body.model).toBe(route.model)
  if (service.compat) {
    expect(request?.body).toHaveProperty('max_tokens', 8192)
    expect(request?.body).not.toHaveProperty('store')
    expect(request?.body.messages).toEqual([{ role: 'system', content: 'Test' }, { role: 'user', content: 'Hello' }])
  }
})

it('applies compatibility defaults only to the exact matching endpoint and protocol', () => {
  const gemini = servicePresets.find(service => service.id === 'google')!
  const connection = { ...gemini.connection, baseUrl: gemini.connection.baseUrl + '/' }
  expect(serviceForConnection(connection)?.id).toBe('google')
  expect(freshModel(connection, 'new-model').compat).toEqual(gemini.compat)
  expect(freshModel({ ...connection, api: 'anthropic-messages' }, 'new-model').compat).toBeUndefined()
  expect(freshModel({ ...connection, baseUrl: 'https://example.test/v1beta/openai' }, 'new-model').compat).toBeUndefined()
  expect(freshModel(connection, 'vision-by-name-only').input).toEqual(['text'])
  expect(freshModel(connection, 'vision-by-name-only').reasoning).toBeUndefined()
})

it('keeps an existing ClinePass connection and its settings when another service is added', () => {
  const x = fixture(), key = randomBytes(32), service = new ModelCatalogService(x.assets, [], key)
  try {
    const connection = { api: 'openai-completions' as const, baseUrl: 'https://api.cline.bot/api/v1' }
    const previous = service.update(1, { id: 'clinepass', label: 'ClinePass', connection, apiKey: 'synthetic-existing-key', models: [{ ...freshModel(connection, 'existing-model'), temperature: .7, compat: { maxTokensField: 'max_tokens', supportsStore: false } }] }, true).providers[0]
    const deepseek = servicePresets.find(service => service.id === 'deepseek')!
    const next = service.update(2, { id: 'new-provider', label: deepseek.label, connection: deepseek.connection, models: [freshModel(deepseek.connection, 'new-model')] }, true)
    expect(next.providers.find(provider => provider.id === 'clinepass')).toEqual(previous)
    expect(next.providers.find(provider => provider.id === 'new-provider')?.credentialConfigured).toBe(false)
    expect(JSON.stringify(next)).not.toContain('synthetic-existing-key')
  } finally { service.close(); x.close() }
})
