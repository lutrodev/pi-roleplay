import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import { WRITER_HISTORY_LIMITS } from '../../../../packages/rp-core/src/agents/writer-history.ts'
import type { WriterHistoryService } from '../services/writer-history-service.ts'
import { dataObject, revision, strict, type Revision } from './schemas.ts'

export function registerWriterHistory(app: FastifyInstance, service: WriterHistoryService) {
  app.get('/api/settings/writer-history', async () => service.snapshot())
  app.put<{ Body: Revision & { config: unknown } }>('/api/settings/writer-history', {
    bodyLimit: WRITER_HISTORY_LIMITS.bytes + 256,
    schema: { body: Type.Object({ expectedRevision: revision, config: dataObject }, strict) },
  }, async request => service.update(request.body.expectedRevision, request.body.config))
}
