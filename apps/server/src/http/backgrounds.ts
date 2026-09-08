import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import { BACKGROUND_INTENSITY, MAX_BACKGROUND_UPLOAD_BYTES, type BackgroundChoice } from '../../../../packages/protocol/src/backgrounds.ts'
import type { BackgroundService } from '../services/background-service.ts'
import { singleUpload, sendDownload } from './download.ts'
import { id, revision, revisionBody, strict, type Revision } from './schemas.ts'

export function registerBackgrounds(app: FastifyInstance, backgrounds: BackgroundService) {
  const params = Type.Object({ imageId: id }, strict)
  app.get('/api/settings/backgrounds', async () => backgrounds.snapshot())
  app.post<{ Querystring: Revision }>('/api/settings/backgrounds', { schema: { querystring: revisionBody } }, async (request, reply) => {
    const upload = await singleUpload(request, MAX_BACKGROUND_UPLOAD_BYTES)
    return reply.code(201).send(await backgrounds.upload(request.query.expectedRevision, upload.bytes, upload.name))
  })
  app.put<{ Body: Revision & BackgroundChoice }>('/api/settings/backgrounds', {
    schema: { body: Type.Object({ expectedRevision: revision, selectedId: Type.Union([id, Type.Null()]), intensity: Type.Integer({ minimum: BACKGROUND_INTENSITY.min, maximum: BACKGROUND_INTENSITY.max }) }, strict) },
  }, async request => backgrounds.update(request.body.expectedRevision, request.body))
  app.patch<{ Params: { imageId: string }; Body: Revision & { name: string } }>('/api/settings/backgrounds/:imageId', {
    schema: { params, body: Type.Object({ expectedRevision: revision, name: Type.String({ minLength: 1, maxLength: 400 }) }, strict) },
  }, async request => backgrounds.rename(request.body.expectedRevision, request.params.imageId, request.body.name))
  app.delete<{ Params: { imageId: string }; Body: Revision }>('/api/settings/backgrounds/:imageId', { schema: { params, body: revisionBody } },
    async request => backgrounds.remove(request.body.expectedRevision, request.params.imageId))
  app.get<{ Params: { imageId: string }; Querystring: { thumbnail?: boolean } }>('/api/settings/backgrounds/:imageId/content', {
    schema: { params, querystring: Type.Object({ thumbnail: Type.Optional(Type.Boolean()) }, strict) },
  }, async (request, reply) => sendDownload(reply, backgrounds.content(request.params.imageId, request.query.thumbnail), 'background.webp', 'image/webp', true))
}
