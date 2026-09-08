import Fastify, { type InjectOptions } from 'fastify'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { registerAuthentication } from '../apps/server/src/http/auth.ts'
import { registerErrors } from '../apps/server/src/http/errors.ts'
import { registerWriterHistory } from '../apps/server/src/http/writer-history.ts'
import { AuthService } from '../apps/server/src/services/auth-service.ts'
import { WriterHistoryService } from '../apps/server/src/services/writer-history-service.ts'
import { fixture } from './helpers.ts'
import { historyConfig } from './writer-history-fixture.ts'
import { exampleWriterHistory } from '../packages/rp-core/src/agents/writer-history-example.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
it('protects the settings endpoint, saves drafts, exposes validation/conflicts/corruption, and bounds the request body', async () => {
  const x = fixture(), app = Fastify({ ajv: { customOptions: { removeAdditional: false } } }), origin = 'http://history.test'
  cleanup.push(async () => { await app.close(); x.close() })
  registerErrors(app)
  const auth = new AuthService(x.assets)
  await registerAuthentication(app, auth, { publicOrigin: origin, sessionKey: randomBytes(32) })
  const service = new WriterHistoryService(x.assets); registerWriterHistory(app, service)
  await auth.setPassword('writer-history-synthetic-password')
  const url = '/api/settings/writer-history'
  expect((await app.inject({ url })).statusCode).toBe(401)
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password: 'writer-history-synthetic-password' } })
  const cookie = String(login.headers['set-cookie']).split(';')[0]!
  const call = (options: InjectOptions) => app.inject({ url, ...options, headers: { cookie, origin, ...options.headers } })
  expect((await call({})).json()).toEqual({ version: 1, revision: 1, config: exampleWriterHistory() })
  const config = service.snapshot().config
  config.rounds[0]!.steps.push({ name: 'optional_tool', argumentsJson: '{unfinished', resultJson: '{}', isError: false })
  expect((await call({ method: 'PUT', payload: { expectedRevision: 1, config } })).statusCode).toBe(200)
  expect((await call({ method: 'PUT', payload: { expectedRevision: 2, config: { ...config, enabled: true } } })).json().error.code).toBe('INVALID_WRITER_HISTORY')
  expect((await call({ method: 'PUT', payload: { expectedRevision: 2, config: historyConfig() } })).json()).toMatchObject({ revision: 3, config: { enabled: true } })
  expect((await call({ method: 'PUT', payload: { expectedRevision: 2, config: historyConfig() } })).statusCode).toBe(409)
  expect((await call({ method: 'PUT', payload: { expectedRevision: 3, config: historyConfig(), unexpected: true } })).statusCode).toBe(400)
  expect((await call({ method: 'PUT', headers: { origin: 'https://evil.test' }, payload: { expectedRevision: 3, config } })).statusCode).toBe(403)
  config.rounds[0]!.user = 'x'.repeat(263_000)
  expect((await call({ method: 'PUT', payload: { expectedRevision: 3, config } })).statusCode).toBe(413)
  expect(service.snapshot().revision).toBe(3)
  x.assets.setSetting('writer.history', { version: 0 })
  expect((await call({})).json().error.code).toBe('WRITER_HISTORY_CORRUPT')
})
