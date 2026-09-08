import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import type { TraceService } from '../services/trace-service.ts'
import { downloadHeaders } from './download.ts'
import { id, strict } from './schemas.ts'

export function registerTrace(app: FastifyInstance, trace: TraceService) {
  const runParams = Type.Object({ runId: id }, strict), storyParams = Type.Object({ storyId: id }, strict)
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/activity', { schema: { params: runParams } }, async request => trace.activity(request.params.runId))
  app.get<{ Params: { storyId: string }; Querystring: { before?: number; after?: number; around?: string; limit?: number; q?: string; deleted?: boolean } }>('/api/stories/:storyId/trajectory', {
    schema: { params: storyParams, querystring: Type.Object({ before: Type.Optional(Type.Integer({ minimum: 1 })), after: Type.Optional(Type.Integer({ minimum: 1 })), around: Type.Optional(id), deleted: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })), q: Type.Optional(Type.String({ maxLength: 300 })) }, strict) },
  }, async request => trace.conversation(request.params.storyId, { ...request.query, q: request.query.q?.trim() }))
  app.get<{ Params: { runId: string }; Querystring: { q?: string } }>('/api/runs/:runId/trajectory', { schema: { params: runParams, querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 300 })) }, strict) } }, async request => trace.trajectory(request.params.runId, request.query.q?.trim()))
  app.get<{ Params: { runId: string }; Querystring: { callId: string } }>('/api/runs/:runId/trajectory-tool', { schema: { params: runParams, querystring: Type.Object({ callId: Type.String({ minLength: 1, maxLength: 1000 }) }, strict) } }, async request => trace.tool(request.params.runId, request.query.callId))
  app.get<{ Params: { runId: string }; Querystring: { q?: string } }>('/api/runs/:runId/trace', { schema: { params: runParams, querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 300 })) }, strict) } }, async request => trace.run(request.params.runId, request.query.q?.trim()))
  app.get<{ Params: { runId: string; requestId: string } }>('/api/runs/:runId/requests/:requestId', { schema: { params: Type.Object({ runId: id, requestId: id }, strict) } }, async request => trace.request(request.params.runId, request.params.requestId))
  app.get<{ Params: { storyId: string }; Querystring: { after?: number; limit?: number; q?: string } }>('/api/stories/:storyId/logs', {
    schema: { params: storyParams, querystring: Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), q: Type.Optional(Type.String({ maxLength: 300 })) }, strict) },
  }, async request => trace.logs(request.params.storyId, request.query.after ?? 0, request.query.limit ?? 20, request.query.q?.trim() ?? ''))
  app.get<{ Params: { storyId: string; seq: number } }>('/api/stories/:storyId/logs/:seq', { schema: { params: Type.Object({ storyId: id, seq: Type.Integer({ minimum: 1 }) }, strict) } }, async request => ({ event: trace.event(request.params.storyId, request.params.seq) }))
  app.get<{ Params: { storyId: string } }>('/api/stories/:storyId/export', { schema: { params: storyParams } }, async (request, reply) => {
    const exported = trace.export(request.params.storyId)
    return downloadHeaders(reply, exported.name, 'application/x-ndjson; charset=utf-8').send(exported.stream)
  })
}
