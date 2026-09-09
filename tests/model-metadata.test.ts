import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { ModelCatalogService } from '../apps/server/src/services/model-catalog-service.ts'
import { discoveryMetadata } from '../apps/server/src/services/model-discovery-metadata.ts'
import { ModelDiscoveryCache } from '../apps/server/src/services/model-discovery-cache.ts'
import { fields, freshModel } from '../apps/web/src/pages/settings/models/catalog.ts'
import { fixture } from './helpers.ts'

const connection = { api: 'openai-completions' as const, baseUrl: 'https://metadata.test/v1' }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(close => close()); vi.restoreAllMocks() })
const metadata = { id: 'gateway/private-model', name: 'Vision Writer', architecture: { input_modalities: ['text', 'image'] }, context_length: 200000, top_provider: { max_completion_tokens: 32000 }, supported_parameters: ['reasoning', 'tools'] }
function setup() {
  const x = fixture(), key = randomBytes(32), requests: { method?: string; body?: Record<string, unknown> }[] = []
  let response: unknown = { data: [metadata] }
  const options = { fetch: async (_url: unknown, init?: RequestInit) => {
    requests.push({ method: init?.method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (init?.method === 'GET') return Response.json(response)
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }, env: () => undefined }
  const service = new ModelCatalogService(x.assets, [], key, options)
  cleanups.push(() => { service.close(); x.close() })
  return { ...x, key, options, service, requests, setResponse: (next: unknown) => { response = next } }
}

it('detects exact catalog capabilities behind a custom connection and never materializes auto overrides', () => {
  const registered = { ...freshModel(connection, 'gpt-4.1'), provider: 'custom', keyEnv: 'KEY' }
  const registry = new ModelRegistry([registered], { env: () => 'synthetic' })
  expect(registry.list()[0]).toMatchObject({ input: ['text', 'image'], sources: { input: 'catalog', contextWindow: 'catalog', maxTokens: 'catalog', reasoning: 'catalog', label: 'catalog' } })
  expect(registry.registrations()[0]).toEqual(registered)
  expect(new ModelRegistry(registry.registrations()).list()[0]?.sources.input).toBe('catalog')
  const unknown = new ModelRegistry([{ ...registered, model: 'my-vision-gpt-4.1' }]).list()[0]!
  expect(unknown).toMatchObject({ input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 8192, sources: { input: 'unknown', reasoning: 'unknown', contextWindow: 'unknown', maxTokens: 'unknown' } })
})

it('reads explicit OpenRouter, Cline and Anthropic fields, rejecting malformed or merely suggestive metadata', () => {
  expect(discoveryMetadata(metadata, connection)).toEqual({ label: 'Vision Writer', input: ['text', 'image'], reasoning: true, contextWindow: 200000, maxTokens: 32000 })
  expect(discoveryMetadata({ supportsImages: false, supportsReasoning: true, contextWindow: 100000, maxTokens: 10000 }, connection)).toEqual({ input: ['text'], reasoning: true, contextWindow: 100000, maxTokens: 10000 })
  expect(discoveryMetadata({ name: 'Vision Reasoner', description: 'supports images', supportsImages: 'true', context_length: -1, max_tokens: '32000', architecture: { input_modalities: ['image', null] } }, connection)).toEqual({ label: 'Vision Reasoner' })
  expect(discoveryMetadata({ max_input_tokens: 200000, max_tokens: 64000, capabilities: { image_input: { supported: true }, thinking: { supported: true, types: { adaptive: { supported: true } } }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: false } } } }, { ...connection, api: 'anthropic-messages' })).toMatchObject({ input: ['text', 'image'], reasoning: true, contextWindow: 200000, maxTokens: 64000, compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: null } })
  expect(discoveryMetadata({ context_length: 10000, max_tokens: 20000 }, connection)).toEqual({ contextWindow: 10000 })
})

it('keeps discovery read-only, persists selected metadata on save, and sends detected vision/reasoning through the real adapter after restart', async () => {
  const x = setup(), before = x.assets.getSetting('models.catalog')
  const discovered = await x.service.discover({ connection, apiKey: 'synthetic-key' })
  expect(x.assets.getSetting('models.catalog')).toEqual(before)
  expect(x.requests.map(request => request.method)).toEqual(['GET'])
  expect(discovered.models[0]?.effective).toMatchObject({ input: ['text', 'image'], sources: { input: 'provider', reasoning: 'provider' } })
  const input = { id: 'service', label: 'Readable Service', connection, apiKey: 'synthetic-key', discoveryId: discovered.discoveryId, models: [freshModel(connection, metadata.id)] }
  const result = x.service.update(1, input, true)
  expect(result.providers[0]?.models[0]).toMatchObject({ effective: { label: 'Vision Writer', providerLabel: 'Readable Service', contextWindow: 200000, maxTokens: 32000, sources: { input: 'provider' } } })
  expect(result.providers[0]?.models[0]?.input).toBeUndefined()
  const restored = new ModelCatalogService(x.assets, [], x.key, x.options)
  const route = { provider: 'service', model: metadata.id }, image = { type: 'image' as const, mimeType: 'image/png', data: 'AA==' }
  const resolved = restored.models.resolve(route, [image])
  expect(resolved.thinkingLevel).toBe('medium')
  await restored.models.stream(resolved.model, { messages: [{ role: 'user', timestamp: 0, content: [{ type: 'text', text: '合成图片测试' }, image] }] }, { reasoning: resolved.thinkingLevel === 'off' ? undefined : resolved.thinkingLevel }).result()
  expect(x.requests.at(-1)?.body).toMatchObject({ model: metadata.id, reasoning_effort: 'medium', max_completion_tokens: 8192, messages: [{ content: [{ type: 'text' }, { type: 'image_url' }] }] })
  const persisted = result.providers[0]!.models.map(fields)
  restored.update(2, { id: 'service', label: 'Renamed', models: persisted })
  expect(restored.models.list()[0]?.sources.input).toBe('provider')
  expect(JSON.stringify(restored.snapshot())).not.toContain('synthetic-key')
})

it('preserves manual overrides, allows reset, invalidates tests on refreshed metadata, and isolates connection/key changes', async () => {
  const x = setup(), draft = await x.service.discover({ connection, apiKey: 'key' })
  const model = { ...freshModel(connection, metadata.id), input: ['text' as const], reasoning: false, contextWindow: 64000, maxTokens: 4096 }
  x.service.update(1, { id: 'service', label: 'Service', connection, apiKey: 'key', discoveryId: draft.discoveryId, models: [model] }, true)
  expect(x.service.models.list()[0]).toMatchObject({ input: ['text'], reasoning: false, contextWindow: 64000, sources: { input: 'manual', reasoning: 'manual' } })
  x.service.update(2, { id: 'service', label: 'Service', models: [freshModel(connection, metadata.id)] })
  await x.service.test(3, 'service', metadata.id)
  expect(x.service.snapshot().providers[0]?.models[0]?.check?.status).toBe('passed')
  x.setResponse({ data: [{ ...metadata, architecture: { input_modalities: ['text'] } }] })
  const refreshed = await x.service.discover({ provider: 'service', connection })
  expect(x.service.models.list()[0]?.input).toEqual(['text', 'image'])
  x.service.update(3, { id: 'service', label: 'Service', discoveryId: refreshed.discoveryId, models: [freshModel(connection, metadata.id)] })
  expect(x.service.models.list()[0]?.input).toEqual(['text'])
  expect(x.service.snapshot().providers[0]?.models[0]?.check).toBeNull()
  x.service.update(4, { id: 'service', label: 'Service', apiKey: 'replacement', models: [freshModel(connection, metadata.id)] })
  expect(x.service.models.list()[0]?.sources.input).toBe('unknown')
  expect(() => x.service.update(5, { id: 'service', label: 'Service', discoveryId: draft.discoveryId, models: [freshModel(connection, metadata.id)] })).toThrow('密钥已变更')
  const other = { ...connection, baseUrl: 'https://other.test/v1' }
  x.service.update(5, { id: 'other', label: 'Other', apiKey: 'key', connection: other, models: [freshModel(other, metadata.id)] }, true)
  expect(x.service.models.list().find(model => model.provider === 'other')?.sources.input).toBe('unknown')
})

it('retains metadata for an explicit per-model connection and rejects stale or forged discovery references', async () => {
  const x = setup(), override = { ...connection, baseUrl: 'https://override.test/v1' }
  const draft = await x.service.discover({ connection: override, apiKey: 'key' })
  x.service.update(1, { id: 'service', label: 'Service', connection, apiKey: 'key', discoveryId: draft.discoveryId, models: [freshModel(override, metadata.id)] }, true)
  expect(x.service.models.list()[0]?.sources.input).toBe('provider')
  expect(x.service.previewMetadata({ provider: 'service', model: metadata.id, connection: override }).sources.input).toBe('provider')
  expect(x.service.previewMetadata({ provider: 'service', model: metadata.id, connection }).sources.input).toBe('unknown')
  expect(() => x.service.update(2, { id: 'service', label: 'Service', discoveryId: 'forged', models: [freshModel(override, metadata.id)] })).toThrow('过期')
  const cache = new ModelDiscoveryCache(randomBytes(32)), id = cache.add(connection, 'secret', [])
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60000)
  expect(() => cache.read(id, connection)).toThrow('过期')
})
