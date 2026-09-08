import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import { ASSET_KINDS, type AssetKind, type JsonObject } from '../../../../packages/rp-core/src/types.ts'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { objectInput } from '../../../../packages/rp-core/src/input.ts'
import { validateEditableLoreEntries } from '../../../../packages/rp-core/src/assets/lore-edit.ts'
import { serializeLoreBookV3 } from '../../../../packages/rp-core/src/lore/activation.js'
import type { AssetRepository } from '../storage/asset-repository.ts'
import type { FileService } from '../services/file-service.ts'
import { dataObject, id, revision, revisionBody, strict, type Revision } from './schemas.ts'
import { sendDownload, singleUpload } from './download.ts'

const kind = Type.Union(ASSET_KINDS.map(value => Type.Literal(value)))
const params = Type.Object({ assetId: id }, strict)
type Params = { assetId: string }

export function registerAssetRoutes(app: FastifyInstance, assets: AssetRepository, files: FileService) {
  app.get<{ Querystring: { kind: AssetKind; q?: string; offset?: number; limit?: number } }>('/api/assets', {
    schema: { querystring: Type.Object({ kind, q: Type.Optional(Type.String({ maxLength: 200 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, strict) },
  }, async request => assets.catalog(request.query.kind, request.query.q, request.query.offset, request.query.limit))
  app.post<{ Body: { kind: AssetKind; data: JsonObject } }>('/api/assets', {
    schema: { body: Type.Object({ kind, data: dataObject }, strict) },
  }, async (request, reply) => {
    editable(request.body.kind, request.body.data)
    return reply.code(201).send({ asset: assets.create(request.body.kind, request.body.data) })
  })
  app.get<{ Params: Params }>('/api/assets/:assetId', { schema: { params } }, async request => ({
    asset: assets.get(request.params.assetId), associatedLorebooks: assets.associatedLorebooks(request.params.assetId).map(({ data: _data, ...item }) => item),
  }))
  app.put<{ Params: Params; Body: Revision & { data: JsonObject } }>('/api/assets/:assetId', {
    schema: { params, body: Type.Object({ expectedRevision: revision, data: dataObject }, strict) },
  }, async request => {
    const current = assets.get(request.params.assetId)
    editable(current.kind, request.body.data)
    return { asset: assets.update(current.id, request.body.expectedRevision, request.body.data) }
  })
  app.delete<{ Params: Params; Body: Revision & { removeAssociated?: boolean } }>('/api/assets/:assetId', {
    schema: { params, body: Type.Object({ expectedRevision: revision, removeAssociated: Type.Optional(Type.Boolean()) }, strict) },
  }, async request => {
    const current = assets.get(request.params.assetId)
    if (current.kind === 'character') return assets.removeCharacter(current.id, request.body.expectedRevision, request.body.removeAssociated ?? true)
    requireValue(request.body.removeAssociated === undefined, 'INVALID_REQUEST', '只有角色卡可以同时删除关联的世界书。')
    return { removedId: assets.remove(current.id, request.body.expectedRevision).id, associatedFailures: [] }
  })
  app.get('/api/assets/defaults', async () => ({ defaults: assets.ensureDefaults() }))
  app.put<{ Body: { kind: 'persona' | 'preset' | 'writingStyle'; assetId: string } }>('/api/assets/defaults', {
    schema: { body: Type.Object({ kind: Type.Union([Type.Literal('persona'), Type.Literal('preset'), Type.Literal('writingStyle')]), assetId: id }, strict) },
  }, async request => { assets.setDefault(request.body.kind, request.body.assetId); return { defaults: assets.ensureDefaults() } })
  app.post('/api/assets/import/character', async (request, reply) => {
    const upload = await singleUpload(request)
    return reply.code(201).send(await files.importCharacter(upload.bytes, upload.name))
  })
  app.post('/api/assets/import/lorebook', async (request, reply) => {
    const upload = await singleUpload(request)
    return reply.code(201).send({ asset: files.importLorebook(upload.bytes) })
  })
  app.get<{ Params: Params; Querystring: { format?: 'json' | 'png' } }>('/api/assets/:assetId/export', {
    schema: { params, querystring: Type.Object({ format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('png')])) }, strict) },
  }, async (request, reply) => {
    const asset = assets.get(request.params.assetId), format = request.query.format ?? 'json'
    if (asset.kind === 'character') {
      const result = files.exportCharacter(asset.id, format)
      return sendDownload(reply, result.bytes, result.name, result.mimeType)
    }
    requireValue(format === 'json', 'INVALID_EXPORT', '只有角色卡支持 PNG 导出。')
    const data = asset.kind === 'lorebook' ? serializeLoreBookV3(asset.data) : asset.data
    return sendDownload(reply, Buffer.from(JSON.stringify(data, null, 2)), asset.name + '.json', 'application/json')
  })
  app.put<{ Params: Params; Querystring: Revision }>('/api/assets/:assetId/avatar', {
    schema: { params, querystring: revisionBody },
  }, async request => {
    const upload = await singleUpload(request)
    return { asset: await files.updateAvatar(request.params.assetId, request.query.expectedRevision, upload.bytes) }
  })
  app.delete<{ Params: Params; Body: Revision }>('/api/assets/:assetId/avatar', {
    schema: { params, body: revisionBody },
  }, async request => ({ asset: await files.updateAvatar(request.params.assetId, request.body.expectedRevision, null) }))
}

function editable(kind: AssetKind, input: unknown) {
  if (kind !== 'lorebook') return
  objectInput(input)
  requireValue(Object.keys(input).every(key => ['name', 'entries', 'scanDepth', 'recursiveScanning'].includes(key)), 'INVALID_ASSET_FIELDS', '世界书包含不可编辑的字段。')
  validateEditableLoreEntries(input.entries)
  requireValue(input.scanDepth === undefined || Number.isSafeInteger(input.scanDepth) && Number(input.scanDepth) >= 0, 'INVALID_LOREBOOK', '扫描深度必须是非负整数。')
  requireValue(input.recursiveScanning === undefined || typeof input.recursiveScanning === 'boolean', 'INVALID_LOREBOOK', '递归扫描设置必须是布尔值。')
}
