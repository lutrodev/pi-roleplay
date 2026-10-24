import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import Fastify from 'fastify'
import { registerModelCatalog } from '../apps/server/src/http/model-catalog.ts'
import { ModelCatalogService } from '../apps/server/src/services/model-catalog-service.ts'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { AssetRepository } from '../apps/server/src/storage/asset-repository.ts'
import { parseModelConfig } from '../apps/server/src/config.ts'
import { fixture } from './helpers.ts'
import { syntheticServiceAccount, vertexConnection as connection, vertexResponse } from './vertex-fixture.ts'

const credential = syntheticServiceAccount(), cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()))
const model = { model: 'google/gemini-2.5-flash', ...connection }
function setup() {
  const x = fixture(), key = randomBytes(32), calls: string[] = []
  const options = { env: () => undefined, fetch: async (url: unknown) => {
    calls.push(String(url))
    return String(url) === 'https://oauth2.googleapis.com/token' ? Response.json({ access_token: 'synthetic-catalog-token', expires_in: 3600 }) : vertexResponse()
  } }
  const service = new ModelCatalogService(x.assets, [], key, options)
  cleanup.push(x.close, () => service.close())
  return { ...x, key, calls, options, service }
}
const input = () => ({ id: 'vertex', label: 'Google Cloud Vertex AI', connection, serviceAccountJson: credential.json, models: [model] })

it('saves encrypted JSON, redacts snapshots, calls through Pi, and restores credentials after reopening SQLite', async () => {
  const x = setup(), snapshot = x.service.update(1, input(), true)
  expect(snapshot.providers[0]).toMatchObject({ keyStored: true, credentialConfigured: true, connection, models: [{ ...model, configured: true }] })
  expect(x.calls).toEqual([])
  expect(snapshot.providers[0]!.models[0]!.effective).toMatchObject({ input: ['text', 'image'], sources: { input: 'catalog' } })
  for (const value of [snapshot, x.assets.getSetting('models.catalog'), x.service.models.list(), x.service.models.registrations()]) {
    expect(JSON.stringify(value)).not.toContain('private_key')
    expect(JSON.stringify(value)).not.toContain(credential.account.client_email)
  }
  x.service.close(); x.database.close()
  expect(readFileSync(x.filename).includes(Buffer.from(credential.account.private_key))).toBe(false)
  const database = new AppDatabase(x.filename); cleanup.push(() => database.close())
  const restored = new ModelCatalogService(new AssetRepository(database), [], x.key, x.options); cleanup.push(() => restored.close())
  expect(await restored.test(2, 'vertex', model.model)).toMatchObject({ status: 'passed' })
  expect(x.calls).toEqual(['https://oauth2.googleapis.com/token', connection.baseUrl + '/chat/completions'])
  expect(() => new ModelCatalogService(new AssetRepository(database), [], randomBytes(32), x.options)).toThrow('无法解密')
})

it('preserves, replaces and removes JSON credentials, including empty connections', async () => {
  const x = setup()
  x.service.update(1, input(), true)
  await x.service.test(2, 'vertex', model.model)
  const renamed = x.service.update(2, { id: 'vertex', label: '改名', models: [model] })
  expect(renamed.providers[0]).toMatchObject({ credentialConfigured: true, models: [{ check: { status: 'passed' } }] })
  const replacement = JSON.stringify({ ...credential.account, client_email: 'replacement@synthetic-project.iam.gserviceaccount.com' })
  const replaced = x.service.update(3, { ...input(), serviceAccountJson: replacement })
  expect(replaced.providers[0]!.models[0]!.check).toBeNull()
  const cleared = x.service.update(4, { id: 'vertex', label: 'Vertex', clearKey: true, models: [] })
  expect(cleared.providers[0]).toMatchObject({ credentialConfigured: false, keyStored: false, connection, models: [] })
  x.service.update(5, { ...input(), models: [] })
  const added = x.service.update(6, { id: 'vertex', label: 'Vertex', models: [{ model: 'gemini-2.5-flash' }] })
  expect(added.providers[0]!.models[0]).toMatchObject({ ...connection, configured: true })
})

it('rejects invalid JSON, credential types and endpoint overrides atomically', () => {
  const x = setup(); x.service.update(1, input(), true)
  const before = x.assets.getSetting('models.catalog')
  for (const changed of [
    { ...input(), serviceAccountJson: '{invalid' },
    { ...input(), apiKey: 'not-service-account' },
    { ...input(), clearKey: true },
    { ...input(), models: [{ ...model, baseUrl: 'https://evil.test/v1' }] },
    { ...input(), models: [{ ...model, api: 'anthropic-messages' }] },
    { ...input(), connection: { api: 'openai-completions', baseUrl: 'https://example.test/v1' } },
    { id: 'vertex', label: 'Vertex', connection: { api: 'openai-completions', baseUrl: 'https://example.test/v1' }, models: [] },
  ]) expect(() => x.service.update(2, changed)).toThrow()
  expect(x.assets.getSetting('models.catalog')).toEqual(before)
  expect(() => x.service.update(2, { ...input(), connection: { ...connection, baseUrl: 123 } })).toThrow('HTTP(S)')
})

it('supports JSON via deployment keyEnv without embedding credentials in model configuration', async () => {
  const x = setup()
  const parsed = parseModelConfig({ models: [{ ...model, provider: 'deployment-vertex', keyEnv: 'VERTEX_ACCOUNT_JSON' }] })
  x.database.sqlite.prepare('DELETE FROM settings WHERE key = ?').run('models.catalog')
  const service = new ModelCatalogService(x.assets, parsed.models, x.key, { ...x.options, env: name => name === 'VERTEX_ACCOUNT_JSON' ? credential.json : undefined })
  cleanup.push(() => service.close())
  expect(service.snapshot().providers[0]).toMatchObject({ connection, keyStored: false, credentialConfigured: true })
  expect(await service.test(1, 'deployment-vertex', model.model)).toMatchObject({ status: 'passed' })
  expect(() => parseModelConfig({ models: [{ ...model, provider: 'vertex', keyEnv: 'KEY', serviceAccountJson: credential.json }] })).toThrow('keyEnv')
})

it('accepts multiline JSON via HTTP, keeps preview local and reports manual model entry explicitly', async () => {
  const x = setup(), app = Fastify({ ajv: { customOptions: { removeAdditional: false } } }); registerModelCatalog(app, x.service)
  try {
    const created = await app.inject({ method: 'POST', url: '/api/settings/providers', payload: { expectedRevision: 1, provider: input() } })
    expect(created.statusCode).toBe(201)
    expect(created.body).not.toContain('private_key')
    const metadata = await app.inject({ method: 'POST', url: '/api/settings/models/metadata', payload: { provider: 'vertex', model: model.model, connection } })
    expect(metadata.statusCode).toBe(200)
    expect(metadata.json()).toMatchObject({ input: ['text', 'image'] })
    expect(x.calls).toEqual([])
    await expect(x.service.discover({ provider: 'vertex', connection })).rejects.toMatchObject({ code: 'MODEL_DISCOVERY_UNSUPPORTED' })
    expect(x.calls).toEqual([])
    const tested = await app.inject({ method: 'POST', url: '/api/settings/providers/vertex/test', payload: { expectedRevision: 2, model: model.model } })
    expect(tested.json()).toMatchObject({ status: 'passed' })
  } finally { await app.close() }
})
