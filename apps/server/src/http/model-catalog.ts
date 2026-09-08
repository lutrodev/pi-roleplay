import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import type { ModelCatalogService } from '../services/model-catalog-service.ts'
import { dataObject, id, revision, strict } from './schemas.ts'

export function registerModelCatalog(app: FastifyInstance, catalog: ModelCatalogService) {
  app.get('/api/settings/providers', async () => catalog.snapshot())
  app.post<{ Body: { provider: string; model: string; connection: unknown } }>('/api/settings/models/reasoning', {
    schema: { body: Type.Object({ provider: id, model: Type.String({ minLength: 1, maxLength: 200 }), connection: dataObject }, strict) },
  }, async request => catalog.previewReasoning(request.body))
  app.post<{ Body: { connection: unknown; provider?: string; apiKey?: string } }>('/api/settings/providers/discover', {
    schema: { body: Type.Object({ connection: dataObject, provider: Type.Optional(id), apiKey: Type.Optional(Type.String({ maxLength: 8192 })) }, strict) },
  }, async request => catalog.discover(request.body))
  app.post<{ Params: { provider: string }; Body: { expectedRevision: number; model: string } }>('/api/settings/providers/:provider/test', {
    schema: { params: Type.Object({ provider: id }, strict), body: Type.Object({ expectedRevision: revision, model: Type.String({ minLength: 1, maxLength: 200 }) }, strict) },
  }, async request => catalog.test(request.body.expectedRevision, request.params.provider, request.body.model))
  app.post<{ Body: { expectedRevision: number; provider: unknown } }>('/api/settings/providers', {
    schema: { body: Type.Object({ expectedRevision: revision, provider: dataObject }, strict) },
  }, async (request, reply) => reply.code(201).send(catalog.update(request.body.expectedRevision, request.body.provider, true)))
  app.put<{ Body: { expectedRevision: number; provider: unknown } }>('/api/settings/providers', {
    schema: { body: Type.Object({ expectedRevision: revision, provider: dataObject }, strict) },
  }, async request => catalog.update(request.body.expectedRevision, request.body.provider))
  app.delete<{ Params: { provider: string }; Body: { expectedRevision: number } }>('/api/settings/providers/:provider', {
    schema: { params: Type.Object({ provider: id }, strict), body: Type.Object({ expectedRevision: revision }, strict) },
  }, async request => catalog.remove(request.body.expectedRevision, request.params.provider))
}
