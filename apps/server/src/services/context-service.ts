import { assembleContext, type ContextPolicy } from '../../../../packages/rp-core/src/context/assemble.ts'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { AssetKind, FileRecord, JsonObject, ModelRoute, StoryProfile } from '../../../../packages/rp-core/src/types.ts'
import type { AssetRepository } from '../storage/asset-repository.ts'
import type { StoryRepository } from '../storage/story-repository.ts'
import { storyReferences } from './story-references.ts'

export class ContextService {
  constructor(readonly stories: StoryRepository, readonly assets: AssetRepository) {}

  preview(storyId: string, runId: string, model: ModelRoute, files: FileRecord[] = [], specialists: JsonObject[] = [], parentInstructions = '', policy: ContextPolicy = {}, profileOverride?: StoryProfile) {
    const saved = this.stories.snapshot(storyId), story = { ...saved, profile: profileOverride ?? saved.profile }
    const r = story.profile.resources
    const bindings: [string, AssetKind][] = [
      ...(r.card ? [[r.card.id, 'character'] as [string, AssetKind]] : []),
      ...(r.persona ? [[r.persona.id, 'persona'] as [string, AssetKind]] : []),
      ...(r.preset ? [[r.preset.id, 'preset'] as [string, AssetKind]] : []),
      ...r.lorebooks.map(item => [item.id, 'lorebook'] as [string, AssetKind]),
      ...r.writingStyles.map(item => [item.id, 'writingStyle'] as [string, AssetKind]),
    ]
    return assembleContext({ story, runId, model, files, specialists, policy: { ...policy, skillInstructions: parentInstructions },
      references: storyReferences(this.stories, story, runId),
      assets: bindings.flatMap(([id, kind]) => { const asset = this.assets.resolve(id, kind); return asset ? [asset] : [] }),
    })
  }

  freeze(runId: string, model: ModelRoute, files: FileRecord[] = [], specialists: JsonObject[] = [], parentInstructions = '', policy: ContextPolicy = {}) {
    return this.stories.database.transaction(() => {
      const run = this.stories.run(runId)
      requireValue(run.status === 'running', 'RUN_STATE_CONFLICT', '当前生成未在运行。', 409)
      const assembly = this.preview(run.storyId, runId, model, files, specialists, parentInstructions, policy)
      const event = this.stories.append(run.storyId, { type: 'context.built', data: {
        runId, model, writerPrompt: assembly.writerPrompt, parentPrompt: assembly.parentPrompt, sources: assembly.sources,
        systemPrompt: assembly.systemPrompt, writerSystemPrompt: assembly.writerSystemPrompt,
        sourceMessageIds: assembly.sourceMessageIds, runtimePrompt: assembly.runtimePrompt,
        attachmentIds: assembly.files.map(file => file.id),
      } })
      return { ...assembly, model, seq: event.seq }
    })
  }

  compact(runId: string, context: ReturnType<ContextService['freeze']>, preserveWriter: boolean) {
    return this.stories.database.transaction(() => {
      const run = this.stories.run(runId)
      requireValue(run.status === 'running', 'RUN_STATE_CONFLICT', '当前生成未在运行。', 409)
      const assembly = { ...context, ...context.withCheckpoint(this.stories.snapshot(run.storyId).checkpoint) }
      if (preserveWriter) {
        this.stories.append(run.storyId, { type: 'context.compacted', data: { runId, basedOnContextSeq: context.seq,
          parentPrompt: assembly.parentPrompt, systemPrompt: assembly.systemPrompt, sourceMessageIds: assembly.sourceMessageIds, runtimePrompt: assembly.runtimePrompt,
        } })
        return assembly
      }
      const event = this.stories.append(run.storyId, { type: 'context.built', data: { runId, model: context.model,
        writerPrompt: assembly.writerPrompt, parentPrompt: assembly.parentPrompt, sources: assembly.sources,
        systemPrompt: assembly.systemPrompt, writerSystemPrompt: assembly.writerSystemPrompt, sourceMessageIds: assembly.sourceMessageIds, runtimePrompt: assembly.runtimePrompt,
        attachmentIds: assembly.files.map(file => file.id),
      } })
      return { ...assembly, seq: event.seq }
    })
  }
}
