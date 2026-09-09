import { randomBytes } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { ModelCatalogService } from '../apps/server/src/services/model-catalog-service.ts'
import { fixture } from './helpers.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
const model = { model: 'custom-model', label: '验收模型', api: 'openai-completions', baseUrl: 'https://model.test/v1', contextWindow: 32000, maxTokens: 4096, outputTokens: 500 }
function setup() {
  const x = fixture(); cleanup.push(x.close)
  const key = randomBytes(32), requests: { url: string; authorization: string | null; body: unknown }[] = [], busy = { value: false }
  const options = { env: (name: string) => name === 'DEPLOY_KEY' ? 'synthetic-deploy-key' : undefined, fetch: async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '连接成功' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } }
  const service = new ModelCatalogService(x.assets, [], key, options, () => busy.value)
  return { ...x, key, options, service, requests, busy }
}
it('previews reasoning without network or credential access and preserves automatic mode through edits and reopen', () => {
  const x = setup(), connection = { api: 'openai-completions', baseUrl: model.baseUrl }
  expect(x.service.previewMetadata({ provider: 'provider-synthetic', model: 'gpt-6-astra', connection })).toMatchObject({ reasoningSource: 'catalog', defaultThinkingLevel: 'medium' })
  expect(x.requests).toEqual([])
  const updated = x.service.update(1, { id: 'provider-synthetic', label: '自动思考', apiKey: 'synthetic-key', models: [{ ...model, model: 'gpt-6-astra' }] }, true)
  const entry = updated.providers[0]!.models[0]!, { configured: _configured, check: _check, effective: _effective, ...fields } = entry
  expect(fields.reasoning).toBeUndefined()
  x.service.update(2, { id: 'provider-synthetic', label: '改名', models: [fields] })
  const restored = new ModelCatalogService(x.assets, [], x.key, x.options)
  expect(restored.models.list()[0]).toMatchObject({ reasoningSource: 'catalog', defaultThinkingLevel: 'medium' })
  expect(restored.models.registrations()[0]?.reasoning).toBeUndefined()
})
it('persists encrypted Web credentials, uses them through the real Pi adapter, and restores with the same deployment secret', async () => {
  const x = setup()
  const updated = x.service.update(1, { id: 'custom', label: '自定义提供方', apiKey: 'synthetic-web-secret', models: [model] }, true)
  expect(updated.providers[0]?.keyStored).toBe(true)
  expect(JSON.stringify(updated)).not.toContain('synthetic-web-secret')
  expect(JSON.stringify(updated)).not.toContain('keyEnv')
  expect(JSON.stringify(x.assets.getSetting('models.catalog'))).not.toContain('synthetic-web-secret')
  const restarted = new ModelCatalogService(x.assets, [], x.key, x.options), route = { provider: 'custom', model: model.model }
  const resolved = restarted.models.resolve(route)
  const result = await restarted.models.stream(resolved.model, { systemPrompt: '测试连接', messages: [{ role: 'user', content: '请回应。', timestamp: 0 }] }).result()
  expect(result.stopReason).toBe('stop')
  expect(x.requests).toEqual([{ url: 'https://model.test/v1/chat/completions', authorization: 'Bearer synthetic-web-secret', body: expect.objectContaining({ model: 'custom-model', max_completion_tokens: 500 }) }])
  expect(() => new ModelCatalogService(x.assets, [], randomBytes(32), x.options)).toThrow('密钥无法解密')
})
it('supports key replacement/removal and model deletion, validates before saving, and refuses conflicting or in-flight edits', () => {
  const x = setup()
  x.service.update(1, { id: 'custom', label: '提供方', apiKey: 'first-synthetic-secret', models: [model] }, true)
  const before = x.assets.getSetting('models.catalog')
  expect(() => x.service.update(2, { id: 'custom', label: '重复提供方', models: [model] }, true)).toThrow('已存在')
  expect(() => x.service.update(2, { id: 'custom', label: '提供方', apiKey: 'other', models: [{ ...model, maxTokens: 999999 }] })).toThrow('输出上限')
  expect(x.assets.getSetting('models.catalog')).toEqual(before)
  expect(() => x.service.remove(1, 'custom')).toThrow('已经更新')
  x.busy.value = true
  expect(() => x.service.remove(2, 'custom')).toThrow('正在运行')
  x.busy.value = false
  x.service.update(2, { id: 'custom', label: '新名称', apiKey: 'second-synthetic-secret', models: [model, { ...model, model: 'second' }] })
  expect(x.service.models.list()).toHaveLength(2)
  x.service.update(3, { id: 'custom', label: '新名称', models: [model], clearKey: true })
  expect(x.service.models.list()).toMatchObject([{ configured: false }])
  expect(x.service.snapshot().providers[0]?.keyStored).toBe(false)
  expect(() => x.service.models.resolve({ provider: 'custom', model: model.model })).toThrow('密钥')
  expect(x.service.remove(4, 'custom').providers).toEqual([])
  expect(new ModelCatalogService(x.assets, [], x.key, x.options).models.list()).toEqual([])
})
it('preserves a deployment environment key on edit and prevents the Web from selecting arbitrary server secrets', () => {
  const x = setup()
  x.assets.database.sqlite.prepare('DELETE FROM settings WHERE key = ?').run('models.catalog')
  const service = new ModelCatalogService(x.assets, [{ ...model, api: 'openai-completions', provider: 'custom', keyEnv: 'DEPLOY_KEY' }], x.key, x.options)
  service.update(1, { id: 'custom', label: '编辑名称', models: [model] })
  expect(service.models.list()[0]?.configured).toBe(true)
  expect(() => service.update(2, { id: 'custom', label: '编辑名称', models: [{ ...model, keyEnv: 'ANOTHER_SERVER_SECRET' }] })).toThrow('不支持')
  service.update(2, { id: 'custom', label: '编辑名称', models: [model], clearKey: true })
  expect(service.models.list()[0]?.configured).toBe(false)
})
