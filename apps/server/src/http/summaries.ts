import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import type { ModelRoute } from '../../../../packages/rp-core/src/types.ts'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { SummaryService } from '../services/summary-service.ts'

export function registerSummaryRoutes(app: FastifyInstance, summaries: SummaryService, route: (storyId: string) => ModelRoute) {
  const id = Type.String({ minLength: 1, maxLength: 128 }), strict = { additionalProperties: false }
  app.post<{ Params: { storyId: string }; Body: { expectedRevision: number; requestId: string } }>('/api/stories/:storyId/summaries', {
    schema: { params: Type.Object({ storyId: id }, strict), body: Type.Object({ expectedRevision: Type.Integer({ minimum: 1 }), requestId: id }, strict) },
  }, async (request, reply) => reply.code(202).send(summaries.startManual(request.params.storyId, request.body.expectedRevision, request.body.requestId, route(request.params.storyId))))
  const params = Type.Object({ storyId: id, summaryId: id }, strict)
  app.post<{ Params: { storyId: string; summaryId: string } }>('/api/stories/:storyId/summaries/:summaryId/stop', { schema: { params } },
    async request => ({ summary: await summaries.cancel(request.params.storyId, request.params.summaryId) }))
  app.get<{ Params: { storyId: string; summaryId: string } }>('/api/stories/:storyId/summaries/:summaryId', { schema: { params } }, async request => {
    const records = summaries.stories.eventsOfTypes(request.params.storyId, ['maintenance.model', 'maintenance.status'], { field: 'id', value: request.params.summaryId }).filter(event => event.type === 'maintenance.model' || event.type === 'maintenance.status' && event.data.kind === 'summary')
    requireValue(records.length, 'SUMMARY_NOT_FOUND', '这次总结记录不存在。', 404)
    return { records }
  })
}
