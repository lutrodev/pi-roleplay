import { verify } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelCredentials, credentialInput, parseServiceAccount } from '../apps/server/src/runtime/model-credentials.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { validateConnection } from '../apps/server/src/services/model-inspection.ts'
import { parseVertexBaseUrl, vertexBaseUrl } from '../packages/protocol/src/model-auth.ts'
import { syntheticServiceAccount, vertexConnection, vertexResponse } from './vertex-fixture.ts'

const { account, json, publicKey } = syntheticServiceAccount()
const signal = () => new AbortController().signal
afterEach(() => vi.restoreAllMocks())

it('validates JSON and whitelists in-memory service-account fields without accepting external auth configuration', () => {
  expect(parseServiceAccount(json)).toMatchObject({ type: 'service_account', project_id: account.project_id, private_key: account.private_key })
  for (const invalid of ['{', 'null', '[]', JSON.stringify({ ...account, type: 'external_account' }), JSON.stringify({ ...account, type: 'authorized_user' }), JSON.stringify({ ...account, project_id: '../project' }), JSON.stringify({ ...account, client_email: 'user@example.test' }), JSON.stringify({ ...account, private_key: 'not-a-private-key' }), JSON.stringify({ ...account, token_uri: 'https://evil.test/token' }), JSON.stringify({ ...account, universe_domain: 'evil.test' }), ' '.repeat(32769)]) {
    expect(() => parseServiceAccount(invalid)).toThrow()
  }
  const normalized = credentialInput({ serviceAccountJson: JSON.stringify({ ...account, credential_source: { file: '/secrets/private' } }) }, 'google-service-account')!
  expect(normalized).not.toContain('/secrets/private')
  expect(() => credentialInput({ apiKey: 'not-json' }, 'google-service-account')).toThrow('需要服务账号')
  expect(() => credentialInput({ serviceAccountJson: json })).toThrow('Vertex AI')
})

it('derives global and regional endpoints and prevents an OAuth token being sent to other hosts or paths', () => {
  for (const location of ['global', 'us-central1', 'europe-west4']) {
    const baseUrl = vertexBaseUrl('synthetic-project', location)
    expect(parseVertexBaseUrl(baseUrl)).toEqual({ project: 'synthetic-project', location })
    expect(validateConnection({ ...vertexConnection, baseUrl })).toEqual({ ...vertexConnection, baseUrl })
  }
  for (const baseUrl of ['https://evil.test/v1', vertexConnection.baseUrl.replace('https:', 'http:'), vertexConnection.baseUrl.replace('global', 'us-central1'), vertexConnection.baseUrl + '?key=secret', vertexConnection.baseUrl.replace('synthetic-project', '..'), vertexConnection.baseUrl.replace('aiplatform.googleapis.com', 'aiplatform.googleapis.com.evil.test')]) {
    expect(() => validateConnection({ ...vertexConnection, baseUrl })).toThrow()
    expect(() => new ModelRegistry([{ ...vertexConnection, baseUrl, model: 'gemini-2.5-flash', provider: 'vertex', keyEnv: 'KEY' }])).toThrow()
  }
  expect(() => validateConnection({ ...vertexConnection, api: 'anthropic-messages' })).toThrow('Chat Completions')
})

it('uses the real Google auth library to sign OAuth assertions, caches tokens, and refreshes before expiry', async () => {
  let now = Date.now(), calls = 0
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const credentials = new ModelCredentials(async (url, init) => {
    calls++
    expect(String(url)).toBe('https://oauth2.googleapis.com/token')
    expect(init?.redirect).toBe('error')
    const form = new URLSearchParams(String(init?.body))
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const assertion = form.get('assertion')!, [header, payload, signature] = assertion.split('.')
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString()).alg).toBe('RS256')
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toMatchObject({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token' })
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true)
    expect(String(init?.body)).not.toContain(account.private_key)
    return Response.json({ access_token: `synthetic-token-${calls}`, expires_in: 3600, token_type: 'Bearer' })
  })
  expect(await credentials.resolve('google-service-account', json, signal())).toBe('synthetic-token-1')
  expect(await credentials.resolve('google-service-account', json, signal())).toBe('synthetic-token-1')
  now += 3541_000
  expect(await credentials.resolve('google-service-account', json, signal())).toBe('synthetic-token-2')
  credentials.clear()
  expect(await credentials.resolve('google-service-account', json, signal())).toBe('synthetic-token-3')
  expect(calls).toBe(3)
})

it('isolates accounts and never reports provider errors containing credentials or assertions', async () => {
  const failing = new ModelCredentials(async () => Response.json({ error: 'invalid_grant', error_description: account.private_key + 'signed-assertion-secret' }, { status: 400 }))
  await expect(failing.resolve('google-service-account', json, signal())).rejects.toMatchObject({ code: 'MODEL_AUTH_FAILED', message: 'Google Cloud 认证失败，请检查服务账号 JSON、密钥状态和服务器时间。' })
  let calls = 0
  const credentials = new ModelCredentials(async () => Response.json({ access_token: `account-${++calls}`, expires_in: 3600 }))
  const other = JSON.stringify({ ...account, client_email: 'other@synthetic-project.iam.gserviceaccount.com' })
  expect(await credentials.resolve('google-service-account', json, signal())).toBe('account-1')
  expect(await credentials.resolve('google-service-account', other, signal())).toBe('account-2')
})

it('cancels OAuth before starting a model request and releases the model queue', async () => {
  let began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  const registry = new ModelRegistry([{ ...vertexConnection, provider: 'vertex', model: 'gemini-2.5-flash', keyEnv: 'KEY' }], {
    env: () => json, fetch: async (url, init) => {
      expect(String(url)).toBe('https://oauth2.googleapis.com/token'); began()
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
    },
  })
  const controller = new AbortController(), model = registry.resolve({ provider: 'vertex', model: 'gemini-2.5-flash' }).model
  const result = registry.stream(model, { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] }, { signal: controller.signal }).result()
  await started; controller.abort()
  expect(await result).toMatchObject({ stopReason: 'aborted' })
})

it('passes only the access token to Pi and preserves image inputs, tools, model identity and output limits', async () => {
  let body: Record<string, unknown> | undefined, generation = 0
  const route = { provider: 'vertex-custom', model: 'gemini-2.5-flash' }
  const registry = new ModelRegistry([{ ...vertexConnection, ...route, keyEnv: 'KEY', outputTokens: 700 }], { env: () => json, fetch: async (url, init) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600 })
    generation++
    expect(String(url)).toBe(vertexConnection.baseUrl + '/chat/completions')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-access-token')
    body = JSON.parse(String(init?.body))
    expect(JSON.stringify([init?.headers, body])).not.toContain('private_key')
    return vertexResponse()
  } })
  const { model } = registry.resolve(route, [{ type: 'image', mimeType: 'image/png', data: 'AA==' }])
  expect(model.input).toContain('image')
  const result = await registry.stream(model, { systemPrompt: 'Write', messages: [{ role: 'user', timestamp: 0, content: [{ type: 'text', text: 'Describe' }, { type: 'image', mimeType: 'image/png', data: 'AA==' }] }], tools: [{ name: 'rp_reply', description: 'Reply', parameters: { type: 'object', properties: {}, required: [] } }] }).result()
  expect(result).toMatchObject({ provider: route.provider, model: route.model, stopReason: 'stop' })
  expect(body).toMatchObject({ model: 'google/gemini-2.5-flash', stream: true, max_tokens: 700, tools: [{ function: { name: 'rp_reply' } }] })
  expect(body).not.toHaveProperty('store')
  expect(body).not.toHaveProperty('reasoning_effort')
  expect(body?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system' }), expect.objectContaining({ role: 'user', content: expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]) })]))
  expect(generation).toBe(1)
})
