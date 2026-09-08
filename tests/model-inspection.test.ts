import { randomBytes } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import Fastify from 'fastify'
import { ModelCatalogService } from '../apps/server/src/services/model-catalog-service.ts'
import { registerModelCatalog } from '../apps/server/src/http/model-catalog.ts'
import { discoverModels, inspectionError, validateConnection } from '../apps/server/src/services/model-inspection.ts'
import { fixture } from './helpers.ts'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(close => close()))
const connection = { api: 'openai-completions' as const, baseUrl: 'https://example.test/v1' }
const fields = { model: 'custom', ...connection, contextWindow: 32000, maxTokens: 4096 }
const ok = () => new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
function setup(fetcher: typeof fetch = async () => ok()) {
  const x = fixture(), key = randomBytes(32), options = { env: (name: string) => name === 'DEPLOY_KEY' ? 'deployment-key' : undefined, fetch: fetcher }
  const service = new ModelCatalogService(x.assets, [], key, options)
  cleanups.push(() => { service.close(); x.close() })
  return { ...x, key, options, service }
}

it('migrates existing models without losing independent endpoints, parameters or environment keys', () => {
  const x = setup()
  const registrations = [{ ...fields, provider: 'existing', keyEnv: 'DEPLOY_KEY', temperature: .2, compat: { supportsStore: false } }, { ...fields, model: 'other', provider: 'existing', keyEnv: 'OTHER_KEY', baseUrl: 'https://other.test/api' }]
  x.assets.setSetting('models.catalog', { version: 1, revision: 7, registrations, labels: { existing: 'Existing service' }, secrets: {} })
  const migrated = new ModelCatalogService(x.assets, [], x.key, x.options)
  expect(migrated.snapshot()).toMatchObject({ revision: 7, providers: [{ id: 'existing', connection, credentialConfigured: true, models: [{ model: 'custom', configured: true, check: null }, { model: 'other', baseUrl: 'https://other.test/api', configured: false }] }] })
  expect(migrated.models.registrations().map(model => model.keyEnv)).toEqual(['DEPLOY_KEY', 'OTHER_KEY'])
  expect(x.assets.getSetting('models.catalog')).toMatchObject({ version: 2, registrations })
  expect(JSON.stringify(migrated.snapshot())).not.toContain('DEPLOY_KEY')
})

it('keeps an empty connection and its credential, and applies connection defaults to newly added models', () => {
  const x = setup()
  x.service.update(1, { id: 'custom', label: 'Service', apiKey: 'saved-secret', connection, models: [] }, true)
  expect(x.service.snapshot().providers[0]).toMatchObject({ credentialConfigured: true, models: [] })
  x.service.update(2, { id: 'custom', label: 'Service', models: [{ model: 'new', contextWindow: 32000, maxTokens: 4096 }] })
  expect(x.service.snapshot().providers[0]?.models[0]).toMatchObject({ model: 'new', ...connection, configured: true })
  x.service.update(3, { id: 'custom', label: 'Service', models: [] })
  expect(() => x.service.update(4, { id: 'custom', label: 'Duplicate', models: [fields] }, true)).toThrow('已存在')
  x.service.remove(4, 'custom'); expect(x.service.snapshot().providers).toEqual([])
})

it('reads actual OpenAI-compatible model identifiers without claiming invocation success or guessing capabilities', async () => {
  let captured: { url: string; headers: Headers; redirect?: RequestRedirect } | undefined
  const result = await discoverModels(connection, 'draft-secret', async (url, options) => {
    captured = { url: String(url), headers: new Headers(options?.headers), redirect: options?.redirect }
    return Response.json({ data: [{ id: 'model-a', name: 'Model A' }, { id: 'model-a' }, { id: 'vision-by-name-only' }, { id: '' }, null] })
  }, new AbortController().signal)
  expect(captured?.url).toBe('https://example.test/v1/models')
  expect(captured?.headers.get('authorization')).toBe('Bearer draft-secret')
  expect(captured?.redirect).toBe('error')
  expect(result).toEqual({ models: [{ model: 'model-a', label: 'model-a' }, { model: 'vision-by-name-only', label: 'vision-by-name-only' }], truncated: false })
})

it('uses Anthropic headers and follows model-list pagination without duplicating v1', async () => {
  const urls: string[] = []
  const result = await discoverModels({ api: 'anthropic-messages', baseUrl: 'https://anthropic.test/v1' }, 'key', async (url, options) => {
    urls.push(String(url)); const headers = new Headers(options?.headers)
    expect(headers.get('x-api-key')).toBe('key'); expect(headers.get('anthropic-version')).toBe('2023-06-01'); expect(headers.has('authorization')).toBe(false)
    return Response.json(urls.length === 1 ? { data: [{ id: 'a', display_name: 'Alpha' }], has_more: true, last_id: 'a' } : { data: [{ id: 'b', display_name: 'Beta' }], has_more: false })
  }, new AbortController().signal)
  expect(urls).toEqual(['https://anthropic.test/v1/models?limit=1000', 'https://anthropic.test/v1/models?limit=1000&after_id=a'])
  expect(result.models.map(model => model.label)).toEqual(['Alpha', 'Beta'])
})

it('rejects malformed lists, unsafe addresses and untrusted credential references without persisting drafts', async () => {
  const x = setup(async () => Response.json({ unexpected: [] }))
  const before = x.assets.getSetting('models.catalog')
  await expect(x.service.discover({ connection, apiKey: 'secret' })).rejects.toMatchObject({ code: 'MODEL_LIST_INVALID' })
  await expect(x.service.discover({ connection, keyEnv: 'DEPLOY_KEY' })).rejects.toThrow('不支持')
  for (const baseUrl of ['file:///private/test', 'https://secret@example.test/v1', 'https://example.test/v1?key=secret', 'https://example.test/v1/chat/completions']) expect(() => validateConnection({ ...connection, baseUrl })).toThrow()
  expect(x.assets.getSetting('models.catalog')).toEqual(before)
})

it('uses stored credentials through Pi, bounds test generation, and persists only sanitized results', async () => {
  const requests: { headers: Headers; body: Record<string, unknown> }[] = []
  const x = setup(async (_url, init) => { requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }); return ok() })
  x.service.update(1, { id: 'custom', label: 'Service', connection, apiKey: 'test-secret', models: [fields] }, true)
  const result = await x.service.test(2, 'custom', 'custom')
  expect(result.status).toBe('passed')
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer test-secret')
  expect(requests[0]?.body).toMatchObject({ model: 'custom', max_completion_tokens: 32, messages: [{ role: 'user', content: 'Reply with OK.' }] })
  expect(requests[0]?.body).not.toHaveProperty('tools')
  const restarted = new ModelCatalogService(x.assets, [], x.key, x.options)
  expect(restarted.snapshot().providers[0]?.models[0]?.check?.status).toBe('passed')
  expect(JSON.stringify(restarted.snapshot())).not.toContain('test-secret')
  expect(JSON.stringify(restarted.snapshot())).not.toContain('fingerprint')
  expect(x.stories.list()).toEqual([])
})

it('invalidates earlier checks when credentials or model configuration change, while preserving failure detail', async () => {
  let fail = false
  const x = setup(async () => fail ? Response.json({ error: { message: '401 secret=never-echo-this-value' } }, { status: 401 }) : ok())
  x.service.update(1, { id: 'custom', label: 'Service', apiKey: 'secret', models: [fields] }, true)
  await x.service.test(2, 'custom', 'custom')
  x.service.update(2, { id: 'custom', label: 'Service', models: [{ ...fields, temperature: .5 }] })
  expect(x.service.snapshot().providers[0]?.models[0]?.check).toBeNull()
  fail = true
  const failure = await x.service.test(3, 'custom', 'custom')
  expect(failure).toMatchObject({ status: 'failed', code: 'MODEL_AUTH_FAILED' })
  expect(JSON.stringify(failure)).not.toContain('never-echo')
  x.service.update(3, { id: 'custom', label: 'Service', apiKey: 'replacement', models: [{ ...fields, temperature: .5 }] })
  expect(x.service.snapshot().providers[0]?.models[0]?.check).toBeNull()
  expect(inspectionError(new Error('timed out at secret-url')).code).toBe('MODEL_TEST_TIMEOUT')
})

it('keeps a stale or removed model from receiving the result of an earlier in-flight check', async () => {
  let respond: (() => void) | undefined
  let started: (() => void) | undefined
  const requestStarted = new Promise<void>(resolve => { started = resolve })
  const x = setup(async () => { await new Promise<void>(resolve => { respond = resolve; started!() }); return ok() })
  x.service.update(1, { id: 'custom', label: 'Service', apiKey: 'secret', models: [fields] }, true)
  const pending = x.service.test(2, 'custom', 'custom')
  await expect(x.service.test(2, 'custom', 'custom')).rejects.toMatchObject({ code: 'MODEL_TEST_BUSY' })
  await requestStarted
  x.service.remove(2, 'custom'); respond!(); await pending
  expect(x.assets.getSetting('models.checks')).toBeUndefined()
})

it('exposes discovery and testing with strict HTTP inputs and revision checks', async () => {
  const x = setup(async (_url, init) => init?.method === 'GET' ? Response.json({ data: [{ id: 'a' }] }) : ok())
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } }); registerModelCatalog(app, x.service)
  try {
    const preview = { connection, provider: 'synthetic', model: 'gpt-6-astra' }
    expect((await app.inject({ method: 'POST', url: '/api/settings/models/reasoning', payload: preview })).json()).toMatchObject({ defaultThinkingLevel: 'medium', thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'] })
    expect((await app.inject({ method: 'POST', url: '/api/settings/models/reasoning', payload: { ...preview, apiKey: 'not-accepted' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/settings/providers/discover', payload: { connection, apiKey: 'secret', arbitrary: true } })).statusCode).toBe(400)
    const list = await app.inject({ method: 'POST', url: '/api/settings/providers/discover', payload: { connection, apiKey: 'secret' } })
    expect(list.json()).toMatchObject({ models: [{ model: 'a' }] })
    x.service.update(1, { id: 'custom', label: 'Service', apiKey: 'secret', models: [fields] }, true)
    await expect(x.service.test(1, 'custom', 'custom')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect((await app.inject({ method: 'POST', url: '/api/settings/providers/custom/test', payload: { expectedRevision: 2, model: 'custom' } })).json()).toMatchObject({ status: 'passed' })
  } finally { await app.close() }
})
