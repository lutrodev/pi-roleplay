import { createHash, timingSafeEqual } from 'node:crypto'
import Fastify from 'fastify'
import { RpError, requireValue } from '../../../packages/rp-core/src/errors.ts'
import { toolIdParamsSchema, toolRequestSchema, type ToolRequest, type ToolWireEvent } from '../../../packages/protocol/src/tools.ts'
import { ToolFilesystem } from './filesystem.ts'
import { ToolRunner } from './runner.ts'

export function createToolServer(options: { token: string; roots: { workspaces: string; inputs: string; skills: string }; logger?: boolean }) {
  requireValue(options.token.length >= 32 && !/[\r\n]/.test(options.token), 'INVALID_TOOLS_CONFIG', '工具服务令牌必须至少为 32 个字符。')
  const expected = createHash('sha256').update('Bearer ' + options.token).digest()
  const runner = new ToolRunner(new ToolFilesystem(options.roots))
  const app = Fastify({ bodyLimit: 2 * 1024 * 1024, requestTimeout: 320_000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
    logger: options.logger ? { level: 'info', redact: ['req.headers.authorization'] } : false,
  })
  app.addHook('onRequest', async (request, reply) => {
    const supplied = createHash('sha256').update(request.headers.authorization ?? '').digest()
    if (!timingSafeEqual(expected, supplied)) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: '工具服务身份验证失败。' } })
  })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RpError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } })
    if ('validation' in (error as object)) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: '工具请求格式不正确。' } })
    request.log.error({ err: error }, 'Tool request failed')
    return reply.code(500).send({ error: { code: 'TOOLS_ERROR', message: '工具服务请求失败。' } })
  })
  app.get('/health', async () => ({ ok: true, ...runner.status() }))
  app.post<{ Body: { directory: string } }>('/v1/workspaces/prepare', { schema: { body: { type: 'object', additionalProperties: false, required: ['directory'], properties: { directory: { type: 'string', minLength: 1, maxLength: 1024 } } } } }, async request => {
    requireValue(!runner.activeCount, 'WORKSPACE_BUSY', '请等待正在运行的工具结束后再创建工作区。', 409)
    return runner.filesystem.prepareDirectory(request.body.directory)
  })
  app.post<{ Body: ToolRequest }>('/v1/execute', { schema: { body: toolRequestSchema } }, async (request, reply) => {
    const emit = (event: ToolWireEvent) => { if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(JSON.stringify(event) + '\n') }
    const job = runner.start(request.body, text => emit({ type: 'output', text }))
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    const disconnect = () => { if (!job.done) job.controller.abort() }
    reply.raw.once('close', disconnect)
    const result = await job.completion
    reply.raw.off('close', disconnect)
    emit(result); reply.raw.end()
  })
  app.post<{ Params: { id: string } }>('/v1/jobs/:id/cancel', { schema: { params: toolIdParamsSchema } }, async request => runner.cancel(request.params.id))
  app.post<{ Params: { id: string } }>('/v1/shells/:id/reset', { schema: { params: toolIdParamsSchema } }, async request => { runner.reset(request.params.id); return { reset: true } })
  app.addHook('preClose', async () => runner.close())
  return { app, runner }
}
