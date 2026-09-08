import { afterEach, describe, expect, it } from 'vitest'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import { projectStory } from '../packages/rp-core/src/story/projection.ts'
import { fixture, message, profile } from './helpers.ts'
import { ModelHistoryService } from '../apps/server/src/services/model-history-service.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(item => item.close()))
const route = { provider: 'test', model: 'test' }

describe('participation inferred from the conversation', () => {
  for (const executionMode of ['chat', 'agent'] as const) {
    it.each(['adaptive', 'actor', 'director'])(`ignores a saved %s flag in ${executionMode} without changing explicit ownership or history`, mode => {
      const x = fixture(); fixtures.push(x)
      const persona = x.assets.create('persona', { name: '叶遥', description: '由我扮演的测绘员。' })
      const legacy = { ...profile(), mode, runtime: { executionMode }, resources: { persona: { id: persona.id }, lorebooks: [], writingStyles: [] } }
      if (mode === 'director') {
        delete legacy.playerCharacterId
        legacy.cast = [{ characterId: 'captain', name: '顾岚', controller: 'agent' }]
      }
      const state = { namespaces: { story: createNamespaceSnapshot({ definition: { title: '精力', updateMode: 'schema-only', rules: [],
        schema: { type: 'object', properties: { energy: { type: 'integer' } }, required: ['energy'], additionalProperties: false },
      }, initialValue: { energy: 37 } }) } }
      // A journal created by an older app still contains its original mode field.
      const story = x.stories.create('旧会话', legacy, state)
      const history = message('assistant', '叶遥把地图摊在桌上。', { kind: 'narrative' })
      x.stories.append(story.id, { type: 'message.added', data: { message: history } })
      const service = new StoryService(x.stories, x.assets, x.files), contexts = new ContextService(x.stories, x.assets)
      const run = service.send(story.id, 'continue', [{ text: '让顾岚走到窗边，但不要替我决定是否登船。', attachmentIds: [] }]).run
      x.stories.setRunStatus(run.id, 'running')
      const frozen = contexts.freeze(run.id, route)
      const ownership = { playerCharacterId: legacy.playerCharacterId,
        cast: legacy.cast.map(member => member.controller === 'user' ? { ...member, name: persona.name } : member), scene: {} }
      for (const prompt of [frozen.systemPrompt, frozen.writerSystemPrompt]) {
        expect(prompt).toContain(JSON.stringify(ownership))
        expect(prompt).not.toContain(`"mode":"${mode}"`)
      }
      for (const prompt of [JSON.stringify(new ModelHistoryService(x.stories).read(x.stories.snapshot(story.id), run.id)), frozen.writerPrompt]) {
        expect(prompt).not.toContain(`"mode":"${mode}"`)
        expect(prompt).toContain('不要替我决定是否登船')
        expect(prompt).toContain('叶遥')
      }
      expect(frozen.systemPrompt).toContain('Infer how the user is participating from each current message')
      expect(frozen.systemPrompt).toContain('does not reassign character ownership')
      expect(frozen.systemPrompt).not.toContain('In adaptive mode')
      x.stories.setRunStatus(run.id, 'completed')
      const before = x.stories.snapshot(story.id), events = x.stories.eventLog(story.id)
      const updated = service.updateProfile(story.id, before.revision, { ...before.profile, scene: { ...before.profile.scene, title: '晴湾码头' } })
      expect(updated.profile).not.toHaveProperty('mode')
      expect(updated.profile.cast).toEqual(before.profile.cast)
      expect(updated.profile.playerCharacterId).toBe(before.profile.playerCharacterId)
      expect(updated.profile.resources).toEqual(before.profile.resources)
      expect(updated.messages).toEqual(before.messages)
      expect(updated.state).toEqual(state)
      expect(x.stories.eventLog(story.id).slice(0, events.length)).toEqual(events)
      expect(x.stories.eventLog(story.id)[0]!.data).toMatchObject({ profile: { mode } })
      expect(projectStory(x.stories.eventLog(story.id))).toEqual(updated)
    })
  }

  it.each([false, true])('creates a conversation without a participation flag (explicit player: %s)', explicitPlayer => {
    const x = fixture(); fixtures.push(x)
    const service = new StoryService(x.stories, x.assets, x.files)
    const story = service.create('自动参与', explicitPlayer ? {} : { cast: [], playerCharacterId: undefined })
    expect(story.profile).not.toHaveProperty('mode')
    expect(story.profile.cast).toHaveLength(explicitPlayer ? 1 : 0)
    expect(story.profile.playerCharacterId).toBe(explicitPlayer ? 'player' : undefined)
    expect(story.messages).toEqual([])
  })
})
