import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import type { WorkspaceAccess } from '../../../../packages/rp-core/src/workspace.ts'
import type { WorkspaceService } from '../services/workspace-service.ts'
import { id, revision, strict } from './schemas.ts'

const access = Type.Union([Type.Literal('read-only'), Type.Literal('read-write')]), name = Type.String({ minLength: 1, maxLength: 120 })
export function registerWorkspaces(app: FastifyInstance, service: WorkspaceService) {
  app.get('/api/workspaces', async () => ({ workspaces: service.list() }))
  app.post<{ Body: { name: string; access?: WorkspaceAccess } }>('/api/workspaces', { schema: { body: Type.Object({ name, access: Type.Optional(access) }, strict) } },
    async (request, reply) => reply.code(201).send({ workspace: await service.create(request.body) }))
  app.put<{ Params: { id: string }; Body: { expectedRevision: number; name: string; access: WorkspaceAccess } }>('/api/workspaces/:id', { schema: { params: Type.Object({ id }, strict), body: Type.Object({ expectedRevision: revision, name, access }, strict) } },
    async request => ({ workspace: service.update(request.params.id, request.body.expectedRevision, request.body) }))
  app.delete<{ Params: { id: string }; Body: { expectedRevision: number } }>('/api/workspaces/:id', { schema: { params: Type.Object({ id }, strict), body: Type.Object({ expectedRevision: revision }, strict) } }, async request => service.remove(request.params.id, request.body.expectedRevision))
  app.get<{ Params: { storyId: string } }>('/api/stories/:storyId/workspace', { schema: { params: Type.Object({ storyId: id }, strict) } }, async request => service.storyInfo(request.params.storyId))
  app.put<{ Params: { storyId: string }; Body: { expectedRevision: number; workspaceId: string | null; access?: WorkspaceAccess } }>('/api/stories/:storyId/workspace', { schema: {
    params: Type.Object({ storyId: id }, strict), body: Type.Object({ expectedRevision: revision, workspaceId: Type.Union([id, Type.Null()]), access: Type.Optional(access) }, strict),
  } }, async request => service.associate(request.params.storyId, request.body.expectedRevision, request.body.workspaceId, request.body.access))
}
