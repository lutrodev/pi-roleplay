import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { FileService } from '../services/file-service.ts'
import type { ToolClient } from '../runtime/tool-client.ts'
import { IMAGE_MIMES, MAX_UPLOAD_BYTES } from '../storage/file-repository.ts'
import { id, strict } from './schemas.ts'
import { sendDownload, singleUpload } from './download.ts'

export function registerFileRoutes(app: FastifyInstance, files: FileService, tools: ToolClient) {
  const params = Type.Object({ fileId: id }, strict)
  app.post('/api/files', async (request, reply) => {
    const upload = await singleUpload(request)
    return reply.code(201).send({ file: await files.upload(upload.bytes, upload.name, upload.mimeType) })
  })
  app.get<{ Params: { fileId: string } }>('/api/files/:fileId', { schema: { params } }, async request => ({ file: files.files.get(request.params.fileId) }))
  app.get<{ Params: { fileId: string }; Querystring: { download?: string } }>('/api/files/:fileId/content', {
    schema: { params, querystring: Type.Object({ download: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])) }, strict) },
  }, async (request, reply) => {
    const { file, bytes } = files.files.read(request.params.fileId)
    return sendDownload(reply, bytes, file.name, file.mimeType, IMAGE_MIMES.has(file.mimeType) && request.query.download !== 'true')
  })
  const storyParams = Type.Object({ storyId: id }, strict), path = Type.String({ minLength: 1, maxLength: 4096 })
  app.get<{ Params: { storyId: string }; Querystring: { path?: string } }>('/api/stories/:storyId/files', {
    schema: { params: storyParams, querystring: Type.Object({ path: Type.Optional(path) }, strict) },
  }, async request => {
    files.stories.assertExists(request.params.storyId)
    return tools.execute(request.params.storyId, { kind: 'list', path: request.query.path }, { signal: AbortSignal.timeout(30000) })
  })
  app.get<{ Params: { storyId: string }; Querystring: { path: string; offset?: number; limit?: number } }>('/api/stories/:storyId/files/preview', {
    schema: { params: storyParams, querystring: Type.Object({ path, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }, strict) },
  }, async request => {
    files.stories.assertExists(request.params.storyId)
    return tools.execute(request.params.storyId, { kind: 'read', ...request.query }, { signal: AbortSignal.timeout(30000) })
  })
  app.get<{ Params: { storyId: string }; Querystring: { path: string } }>('/api/stories/:storyId/files/download', {
    schema: { params: storyParams, querystring: Type.Object({ path }, strict) },
  }, async (request, reply) => {
    files.stories.assertExists(request.params.storyId)
    const result = await tools.execute(request.params.storyId, { kind: 'download', path: request.query.path }, { signal: AbortSignal.timeout(30000) })
    requireValue(result && typeof result === 'object' && 'base64' in result && typeof result.base64 === 'string' && result.base64.length <= Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 4 && 'name' in result && typeof result.name === 'string', 'TOOL_PROTOCOL_ERROR', '工具文件下载结果不完整。', 502)
    return sendDownload(reply, Buffer.from(result.base64, 'base64'), result.name, 'application/octet-stream')
  })
}
