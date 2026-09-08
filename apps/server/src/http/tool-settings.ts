import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import type { ToolSettingsService } from '../services/tool-settings-service.ts'
import { dataObject, revision, strict, type Revision } from './schemas.ts'

export function registerToolSettings(app: FastifyInstance, service: ToolSettingsService) {
  app.get('/api/settings/tools', async () => service.snapshot())
  app.put<{ Body: Revision & { settings: unknown; apiKey?: string; clearKey?: boolean } }>('/api/settings/tools', {
    schema: { body: Type.Object({ expectedRevision: revision, settings: dataObject, apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })), clearKey: Type.Optional(Type.Boolean()) }, strict) },
  }, async request => service.update(request.body.expectedRevision, request.body.settings, request.body.apiKey, request.body.clearKey))
}
