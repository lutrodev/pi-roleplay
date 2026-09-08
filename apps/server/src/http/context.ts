import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import { normalizeProfile } from '../../../../packages/rp-core/src/story/profile.js'
import { RpError } from '../../../../packages/rp-core/src/errors.ts'
import type { ContextService } from '../services/context-service.ts'
import type { SettingsService } from '../services/settings-service.ts'
import type { ModelRoute, StoryProfile } from '../../../../packages/rp-core/src/types.ts'
import { dataObject, id, strict } from './schemas.ts'
import { contextUsage } from '../services/context-usage.ts'

export function registerContextPreview(app: FastifyInstance, contexts: ContextService, settings: SettingsService, defaultMain?: ModelRoute | null) {
  app.get<{ Params: { storyId: string } }>('/api/stories/:storyId/context-usage', { schema: { params: Type.Object({ storyId: id }, strict) } },
    async request => ({ usage: contextUsage(contexts.stories, request.params.storyId) }))
  app.post<{ Params: { storyId: string }; Body: { profile: unknown } }>('/api/stories/:storyId/context-preview', {
    schema: { params: Type.Object({ storyId: id }, strict), body: Type.Object({ profile: dataObject }, strict) },
  }, async request => {
    const story = contexts.stories.snapshot(request.params.storyId), { preferences } = settings.snapshot()
    let profile: StoryProfile
    try { profile = normalizeProfile(request.body.profile, story.profile.revision) as StoryProfile }
    catch (error) { throw new RpError('INVALID_PROFILE', '预览需要完整且有效的故事配置。', 400, error instanceof Error ? error.message : undefined) }
    // This is explicitly an RP material preview, before a user input or model invocation exists.
    const inherited = preferences.mainModel ?? defaultMain
    const model = profile.runtime.model ?? inherited?.model ?? '（尚未选择模型）'
    const { withCheckpoint: _rebuild, ...assembly } = contexts.preview(story.id, '', { provider: profile.runtime.provider ?? inherited?.provider ?? 'preview', model }, [], [], '',
      { identity: preferences.identity, replyOptions: preferences.replyOptionsEnabled ? preferences.replyOptions : undefined }, profile)
    return assembly
  })
}
