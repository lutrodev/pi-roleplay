import Fastify from 'fastify'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { AssetRepository } from '../apps/server/src/storage/asset-repository.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../apps/server/src/services/auth-service.ts'
import { registerAuthentication } from '../apps/server/src/http/auth.ts'
import { registerErrors } from '../apps/server/src/http/errors.ts'
import { fixture } from './helpers.ts'

const clean: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of clean.splice(0)) await close() })
const password = 'synthetic-admin-password', origin = 'https://rp.test'
async function setup(loginAttempts = 20, publicOrigin = origin) {
  const x = fixture(), auth = new AuthService(x.assets)
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } })
  clean.push(async () => { await app.close(); x.close() })
  registerErrors(app)
  await registerAuthentication(app, auth, { publicOrigin, sessionKey: randomBytes(32), loginAttempts })
  app.get('/api/private', async () => ({ private: true }))
  app.post('/api/change', async () => ({ changed: true }))
  app.get('/health', async () => ({ ok: true }))
  await auth.setPassword(password)
  return { ...x, auth, app }
}
function cookie(response: { headers: Record<string, unknown> }) { return String(response.headers['set-cookie']).split(';')[0]! }

describe('single administrator authentication', () => {
  it('keeps independent same-host instances logged in and logs out only the selected instance', async () => {
    const origins = ['http://127.0.0.1:3091', 'http://127.0.0.1:3093'], instances = await Promise.all(origins.map(origin => setup(20, origin)))
    const cookies = await Promise.all(instances.map(async (instance, index) => cookie(await instance.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: origins[index] }, payload: { password } }))))
    expect(new Set(cookies.map(value => value.split('=')[0])).size).toBe(2)
    const browserCookies = cookies.join('; ')
    for (const instance of instances) expect((await instance.app.inject({ url: '/api/private', headers: { cookie: browserCookies } })).statusCode).toBe(200)
    const logout = await instances[0]!.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: origins[0], cookie: browserCookies } })
    expect(cookie(logout).split('=')[0]).toBe(cookies[0]!.split('=')[0])
    expect((await instances[1]!.app.inject({ url: '/api/private', headers: { cookie: cookies[1] } })).statusCode).toBe(200)
  })
  it('initializes and resets credentials through the real CLI without echoing the supplied password', async () => {
    const x = await setup(), target = join(x.directory, 'cli-data')
    const cli = (secret: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/cli.ts', 'set-password', '--password-stdin', '--data-dir', target], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] })
      let output = ''
      child.on('error', reject); child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
      child.on('close', code => resolve({ code, output })); child.stdin.end(secret + '\n')
    })
    const first = await cli(password)
    expect(first.code).toBe(0)
    expect(first.output).toContain('密码已保存')
    expect(first.output).not.toContain(password)
    const database = new AppDatabase(join(target, 'app.sqlite'))
    try {
      const auth = new AuthService(new AssetRepository(database)), epoch = await auth.verify(password)
      expect(epoch).not.toBe(null)
      expect((await cli('replacement-cli-password')).code).toBe(0)
      expect(auth.epoch()).not.toBe(epoch)
      expect(await auth.verify(password)).toBe(null)
      expect(await auth.verify('replacement-cli-password')).not.toBe(null)
    } finally { database.close() }
  })

  it('persists salted scrypt credentials and revokes earlier sessions after a password reset', async () => {
    const x = await setup(), firstEpoch = await x.auth.verify(password)
    expect(firstEpoch).toEqual(expect.any(String))
    expect(await new AuthService(x.assets).verify(password)).toBe(firstEpoch)
    expect(JSON.stringify(x.assets.getSetting('private.admin'))).not.toContain(password)
    expect(await x.auth.verify('incorrect-password')).toBe(null)
    await x.auth.setPassword('a-new-synthetic-password')
    expect(x.auth.epoch()).not.toBe(firstEpoch)
    expect(await x.auth.verify(password)).toBe(null)
    await expect(x.auth.setPassword('short')).rejects.toThrow('12')
  })

  it('uses an encrypted Secure/HttpOnly cookie, guards APIs, and clears the cookie on logout', async () => {
    const x = await setup()
    expect((await x.app.inject('/health')).statusCode).toBe(200)
    expect((await x.app.inject('/api/private')).statusCode).toBe(401)
    expect((await x.app.inject('/api/auth/session')).json()).toEqual({ configured: true, authenticated: false })
    const login = await x.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password } })
    expect(login.statusCode).toBe(200)
    const header = String(login.headers['set-cookie'])
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict']) expect(header).toContain(flag)
    expect(header).not.toContain(password)
    expect(header).not.toContain(x.auth.epoch())
    const session = cookie(login)
    expect((await x.app.inject({ url: '/api/private', headers: { cookie: session } })).statusCode).toBe(200)
    expect((await x.app.inject({ url: '/api/private', headers: { cookie: session.split('=')[0] + '=tampered' } })).statusCode).toBe(401)
    const logout = await x.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin, cookie: session } })
    expect(logout.statusCode).toBe(204)
    expect(String(logout.headers['set-cookie'])).toMatch(/Expires=.*1970/)
  })

  it('rejects cross-origin changes and makes existing cookies invalid after reset', async () => {
    const x = await setup()
    expect((await x.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } })).statusCode).toBe(403)
    const login = await x.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password } })
    const headers = { origin, cookie: cookie(login) }
    expect((await x.app.inject({ method: 'POST', url: '/api/change', headers: { ...headers, origin: 'https://outside.test' } })).statusCode).toBe(403)
    expect((await x.app.inject({ method: 'POST', url: '/api/change', headers })).statusCode).toBe(200)
    await x.auth.setPassword('another-synthetic-password')
    expect((await x.app.inject({ url: '/api/private', headers })).statusCode).toBe(401)
  })

  it('limits login attempts globally so spoofed proxy/IP headers cannot bypass the single-admin limit', async () => {
    const x = await setup(2)
    for (let index = 0; index < 2; index++) expect((await x.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin, 'x-forwarded-for': `192.0.2.${index}` }, payload: { password: 'wrong' } })).statusCode).toBe(401)
    const limited = await x.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin, 'x-forwarded-for': '192.0.2.99' }, payload: { password } })
    expect(limited.statusCode).toBe(429)
    expect(limited.json().error.code).toBe('RATE_LIMITED')
    expect(limited.headers['retry-after']).toBeDefined()
  })
})
