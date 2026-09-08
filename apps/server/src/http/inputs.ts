import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import type { MessageInput } from '../../../../packages/rp-core/src/types.ts'
import type { InputQueueService } from '../services/input-queue-service.ts'
import type { RunQueue } from '../runtime/queue.ts'

const id = Type.String({ minLength: 1, maxLength: 128 }), strict = { additionalProperties: false }
const inputs = Type.Array(Type.Object({ text: Type.String({ maxLength: 200000 }), attachmentIds: Type.Array(id, { maxItems: 16 }) }, strict), { minItems: 1, maxItems: 16 })
const mode = Type.Union([Type.Literal('queue'), Type.Literal('steer')]), revision = Type.Integer({ minimum: 1 })
type Payload = { inputs: MessageInput[]; mode: 'queue' | 'steer'; targetRunId?: string }
type Params = { storyId: string; inputId: string }
export function registerInputRoutes(app: FastifyInstance, service: InputQueueService, queue: RunQueue) {
  app.get<{ Params: { storyId: string } }>('/api/stories/:storyId/input-queue', { schema: { params: Type.Object({ storyId: id }, strict) } }, async request => ({ items: service.list(request.params.storyId) }))
  app.post<{ Params: { storyId: string }; Body: Payload & { requestId: string } }>('/api/stories/:storyId/input-queue', {
    schema: { params: Type.Object({ storyId: id }, strict), body: Type.Object({ requestId: id, inputs, mode, targetRunId: Type.Optional(id) }, strict) },
  }, async (request, reply) => {
    const { requestId, inputs, mode, targetRunId } = request.body
    const result = service.submit(request.params.storyId, requestId, inputs, mode, targetRunId)
    queue.wake(); return reply.code(202).send(result)
  })
  app.put<{ Params: Params; Body: Payload & { expectedRevision: number } }>('/api/stories/:storyId/input-queue/:inputId', {
    schema: { params: Type.Object({ storyId: id, inputId: id }, strict), body: Type.Object({ expectedRevision: revision, inputs, mode, targetRunId: Type.Optional(id) }, strict) },
  }, async request => {
    const { expectedRevision, inputs, mode, targetRunId } = request.body
    const item = service.update(request.params.storyId, request.params.inputId, expectedRevision, inputs, mode, targetRunId)
    queue.wake(); return { item }
  })
  app.delete<{ Params: Params; Body: { expectedRevision: number } }>('/api/stories/:storyId/input-queue/:inputId', {
    schema: { params: Type.Object({ storyId: id, inputId: id }, strict), body: Type.Object({ expectedRevision: revision }, strict) },
  }, async request => ({ item: service.remove(request.params.storyId, request.params.inputId, request.body.expectedRevision) }))
  app.post<{ Params: { storyId: string }; Body: { targetRunId: string; items: { id: string; revision: number }[] } }>('/api/stories/:storyId/input-queue/steer', {
    schema: { params: Type.Object({ storyId: id }, strict), body: Type.Object({ targetRunId: id, items: Type.Array(Type.Object({ id, revision }, strict), { minItems: 1, maxItems: 64 }) }, strict) },
  }, async request => ({ items: service.steerAll(request.params.storyId, request.body.targetRunId, request.body.items) }))
}
