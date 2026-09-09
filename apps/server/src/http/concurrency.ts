import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import type { ConcurrencyService } from '../services/concurrency-service.ts'
import { dataObject, revision, strict } from './schemas.ts'

export function registerConcurrency(app: FastifyInstance, service: ConcurrencyService) {
  app.get('/api/settings/concurrency', async () => service.snapshot())
  app.put<{ Body: { expectedRevision: number; settings: unknown } }>('/api/settings/concurrency', {
    schema: { body: Type.Object({ expectedRevision: revision, settings: dataObject }, strict) },
  }, async request => service.update(request.body.expectedRevision, request.body.settings))
}
