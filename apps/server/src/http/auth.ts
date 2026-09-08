import secureSession from '@fastify/secure-session'
import rateLimit from '@fastify/rate-limit'
import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { AuthService } from '../services/auth-service.ts'

declare module '@fastify/secure-session' { interface SessionData { adminEpoch: string } }

export async function registerAuthentication(app: FastifyInstance, auth: AuthService, options: { publicOrigin: string; sessionKey: Buffer; loginAttempts?: number }) {
  const origin = new URL(options.publicOrigin)
  requireValue(['http:', 'https:'].includes(origin.protocol) && origin.origin === options.publicOrigin, 'INVALID_ORIGIN', '公开访问地址需要是没有路径的 HTTP(S) origin。')
  requireValue(options.sessionKey.length === 32, 'INVALID_SESSION_KEY', '会话加密密钥需要恰好 32 字节。')
  // Browsers scope cookies by host and path, not port. Independent instances must not overwrite each other's sessions.
  const cookieName = 'rp_session_' + createHash('sha256').update(origin.origin).digest('hex').slice(0, 16)
  await app.register(secureSession, { key: options.sessionKey, cookieName, expiry: 7 * 86400,
    cookie: { path: '/', httpOnly: true, secure: origin.protocol === 'https:', sameSite: 'strict', maxAge: 7 * 86400 } })
  await app.register(rateLimit, { global: false })
  const authenticated = (request: FastifyRequest) => {
    const epoch = request.session.get('adminEpoch')
    return typeof epoch === 'string' && epoch === auth.epoch()
  }
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!
    if (!path.startsWith('/api/')) return
    reply.header('cache-control', 'no-store')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) requireValue(request.headers.origin === options.publicOrigin, 'ORIGIN_REJECTED', '请求来源与应用地址不一致，请从正常页面重试。', 403)
    if (path === '/api/auth/login' || path === '/api/auth/session') return
    requireValue(authenticated(request), 'AUTH_REQUIRED', '请先登录。', 401)
  })
  app.get('/api/auth/session', async request => ({ authenticated: authenticated(request), configured: auth.configured() }))
  app.post<{ Body: { password: string } }>('/api/auth/login', {
    config: { rateLimit: { max: options.loginAttempts ?? 20, timeWindow: 15 * 60 * 1000, keyGenerator: () => 'single-admin-login' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } } } },
  }, async (request, reply) => {
    const epoch = await auth.verify(request.body.password)
    requireValue(epoch, 'LOGIN_FAILED', '密码不正确。', 401)
    request.session.set('adminEpoch', epoch)
    return reply.send({ authenticated: true })
  })
  app.post('/api/auth/logout', async (request, reply) => { request.session.delete(); return reply.code(204).send() })
  return { authenticated }
}
