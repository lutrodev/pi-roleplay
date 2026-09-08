import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import { disabledSkillNames } from '../../../../packages/rp-core/src/settings/skills.ts'
import { normalizePreferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import { promptProjection } from '../services/prompt-projection.ts'
import type { SettingsService } from '../services/settings-service.ts'
import type { ModelRoute } from '../../../../packages/rp-core/src/types.ts'
import type { SkillService } from '../services/skill-service.ts'
import type { SubagentService } from '../services/subagent-service.ts'
import { dataObject, id, revision, revisionBody, strict, type Revision } from './schemas.ts'

export function registerSettingsRoutes(app: FastifyInstance, settings: SettingsService, skills: SkillService, subagents: SubagentService, defaultMain?: ModelRoute | null) {
  app.get('/api/settings', async () => settings.snapshot())
  app.put<{ Body: Revision & { preferences: unknown } }>('/api/settings', {
    schema: { body: Type.Object({ expectedRevision: revision, preferences: dataObject }, strict) },
  }, async request => settings.update(request.body.expectedRevision, request.body.preferences))
  app.get('/api/settings/models', async () => ({ models: settings.models.list(), effectiveMain: settings.snapshot().preferences.mainModel ?? defaultMain ?? null }))
  app.post<{ Body: { preferences: unknown } }>('/api/settings/prompt-preview', {
    schema: { body: Type.Object({ preferences: dataObject }, strict) },
  }, async request => promptProjection(normalizePreferences(request.body.preferences), skills, subagents, defaultMain))
  app.get('/api/settings/skills', async () => {
    const { preferences } = settings.snapshot(), snapshot = await skills.snapshot()
    const disabled = disabledSkillNames(preferences.disabledSkills)
    return { skills: snapshot.skills.map(item => ({ ...item, enabled: preferences.skills && !disabled.includes(item.name) })), diagnostics: snapshot.diagnostics }
  })
  app.get('/api/settings/subagents', async () => subagents.snapshot())
  app.post<{ Body: { subagent: unknown } }>('/api/settings/subagents', { schema: { body: Type.Object({ subagent: dataObject }, strict) } },
    async (request, reply) => reply.code(201).send({ subagent: subagents.create(request.body.subagent) }))
  const params = Type.Object({ subagentId: id }, strict)
  app.put<{ Params: { subagentId: string }; Body: Revision & { subagent: unknown } }>('/api/settings/subagents/:subagentId', {
    schema: { params, body: Type.Object({ expectedRevision: revision, subagent: dataObject }, strict) },
  }, async request => ({ subagent: subagents.update(request.params.subagentId, request.body.expectedRevision, request.body.subagent) }))
  app.patch<{ Params: { subagentId: string }; Body: Revision & { enabled: boolean } }>('/api/settings/subagents/:subagentId', {
    schema: { params, body: Type.Object({ expectedRevision: revision, enabled: Type.Boolean() }, strict) },
  }, async request => ({ subagent: subagents.setEnabled(request.params.subagentId, request.body.expectedRevision, request.body.enabled) }))
  app.delete<{ Params: { subagentId: string }; Body: Revision }>('/api/settings/subagents/:subagentId', {
    schema: { params, body: revisionBody },
  }, async request => subagents.remove(request.params.subagentId, request.body.expectedRevision))
  app.put<{ Body: Revision & { route: unknown } }>('/api/settings/writer', {
    schema: { body: Type.Object({ expectedRevision: revision, route: dataObject }, strict) },
  }, async request => ({ writer: subagents.updateWriter(request.body.expectedRevision, request.body.route) }))
}
