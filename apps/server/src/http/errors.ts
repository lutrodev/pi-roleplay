import type { FastifyError, FastifyInstance } from 'fastify'
import { RpError } from '../../../../packages/rp-core/src/errors.ts'

export function registerErrors(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RpError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } })
    const failure: Partial<FastifyError> = error !== null && typeof error === 'object' ? error : { name: 'UnknownError' }
    if (failure.validation) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: '请求格式不正确，请检查填写内容。', fields: failure.validation.map(item => item.instancePath) } })
    if (failure.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试。' } })
    if (failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500) return reply.code(failure.statusCode).send({ error: { code: failure.code ?? 'INVALID_REQUEST', message: '请求无法处理，请检查格式和大小。' } })
    // Do not serialize arbitrary provider or request errors: those can contain credentials or source material.
    request.log.error({ code: failure.code ?? 'INTERNAL_ERROR', errorType: failure.name }, 'Request failed')
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '服务暂时无法完成操作，请检查服务状态。' } })
  })
}
