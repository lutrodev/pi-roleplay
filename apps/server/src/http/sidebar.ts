import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import type { SidebarService } from '../services/sidebar-service.ts'
import type { SidebarUpdate } from '../../../../packages/protocol/src/sidebar.ts'
import { id, revision, strict } from './schemas.ts'

export function registerSidebar(app: FastifyInstance, sidebar: SidebarService) {
  app.get('/api/settings/sidebar', async () => sidebar.snapshot())
  app.put<{ Body: SidebarUpdate & { expectedRevision: number } }>('/api/settings/sidebar', {
    schema: { body: Type.Object({ expectedRevision: revision, sort: Type.Union([Type.Literal('recent'), Type.Literal('manual')]), order: Type.Array(id, { maxItems: 10000, uniqueItems: true }), view: Type.Union([Type.Literal('single'), Type.Literal('workspaces')]), workspaceOrder: Type.Array(id, { maxItems: 1000, uniqueItems: true }), pinnedStoryIds: Type.Array(id, { maxItems: 10000, uniqueItems: true }) }, strict) },
  }, async request => sidebar.update(request.body.expectedRevision, request.body.sort, request.body.order, request.body.view, request.body.workspaceOrder, request.body.pinnedStoryIds))
  app.patch<{ Params: { storyId: string }; Body: { expectedRevision: number; pinned: boolean } }>('/api/settings/sidebar/pins/:storyId', {
    schema: { params: Type.Object({ storyId: id }, strict), body: Type.Object({ expectedRevision: revision, pinned: Type.Boolean() }, strict) },
  }, async request => sidebar.pin(request.body.expectedRevision, request.params.storyId, request.body.pinned))
}
