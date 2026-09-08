import { afterEach, describe, expect, it } from 'vitest'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { assembleContext } from '../packages/rp-core/src/context/assemble.ts'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import type { ExecutionMode, StoryProfile } from '../packages/rp-core/src/types.ts'
import { fixture, message, profile } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(item => item.close()))
const route = { provider: 'test', model: 'test' }
function setup(mode: ExecutionMode = 'agent') {
  const x = fixture(); fixtures.push(x)
  const first = x.assets.create('persona', { name: '阿舟', description: '旧人设描述' })
  const second = x.assets.create('persona', { name: '叶遥', description: '新人设描述' })
  const card = x.assets.create('character', { name: '守塔人', description: '我和 {{user}} 一起守候海岸。' })
  const config: StoryProfile = { ...profile(), runtime: { executionMode: mode }, cast: [
    { characterId: 'npc', name: '旁观者', controller: 'agent' },
    { characterId: 'player', name: '会话原名', controller: 'user' },
  ], resources: { persona: { id: first.id }, card: { id: card.id }, lorebooks: [], writingStyles: [] } }
  const state = { namespaces: { story: createNamespaceSnapshot({ definition: { title: '精力', updateMode: 'schema-only', rules: [],
    schema: { type: 'object', properties: { energy: { type: 'integer' } }, required: ['energy'], additionalProperties: false },
  }, initialValue: { energy: 37 } }) } }
  const story = x.stories.create('人设实时引用', config, state)
  const history = message('assistant', '阿舟把信交给守塔人。', { kind: 'narrative' })
  x.stories.append(story.id, { type: 'message.added', data: { message: history } })
  const service = new StoryService(x.stories, x.assets, x.files), contexts = new ContextService(x.stories, x.assets)
  return { ...x, story, first, second, card, history, state, service, contexts }
}
function expectParticipation(context: ReturnType<typeof assembleContext>, expected: object) {
  for (const prompt of [context.systemPrompt, context.writerSystemPrompt]) expect(prompt).toContain(JSON.stringify(expected))
}

describe('live persona identity in frozen context', () => {
  it.each(['chat', 'agent'] as const)('keeps %s participation, persona and macros in sync after binding and renaming, without rewriting history', mode => {
    const x = setup(mode)
    let run = x.service.send(x.story.id, 'first', [{ text: '检查当前资料。', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running')
    const first = x.contexts.freeze(run.id, route)
    const before = x.stories.snapshot(x.story.id), events = x.stories.eventLog(x.story.id)
    if (mode === 'agent') x.service.bindDuringRun(run.id, { personaId: x.second.id })
    else {
      x.stories.setRunStatus(run.id, 'completed')
      x.service.updateProfile(x.story.id, x.stories.snapshot(x.story.id).revision, { ...before.profile, resources: { ...before.profile.resources, persona: { id: x.second.id } } })
      run = x.service.send(x.story.id, 'second', [{ text: '检查当前资料。', attachmentIds: [] }]).run
      x.stories.setRunStatus(run.id, 'running')
    }
    const rebound = x.contexts.freeze(run.id, route)
    const beforeRename = x.stories.snapshot(x.story.id).profile
    x.assets.update(x.second.id, x.second.revision, { ...x.second.data, name: '叶遥的新名字' })
    const renamed = x.contexts.freeze(run.id, route)
    for (const [context, name] of [[first, '阿舟'], [rebound, '叶遥'], [renamed, '叶遥的新名字']] as const) {
      expectParticipation(context, { playerCharacterId: 'player', cast: [
        { characterId: 'npc', name: '旁观者', controller: 'agent' }, { characterId: 'player', name, controller: 'user' },
      ], scene: {} })
      expect(context.identities.userName).toBe(name)
      expect(context.replyOptionsPlayer).toEqual({ characterId: 'player', name })
      expect(context.sources.find(source => source.id === 'rp.persona')!.text).toContain(`name: ${name}\n`)
      for (const prompt of [context.parentPrompt, context.writerPrompt]) {
        expect(prompt).not.toContain('"playerCharacterId"')
        expect(prompt).not.toContain('角色与控制权')
        expect(prompt).toContain(`我和 ${name} 一起守候海岸。`)
        expect(prompt).not.toContain('会话原名')
      }
    }
    expect(rebound.systemPrompt).not.toEqual(renamed.systemPrompt)
    expect(rebound.writerSystemPrompt).not.toEqual(renamed.writerSystemPrompt)
    expect(x.stories.snapshot(x.story.id).profile).toEqual(beforeRename)
    expect(x.stories.snapshot(x.story.id).state).toEqual(x.state)
    expect(x.stories.snapshot(x.story.id).messages.find(item => item.id === x.history.id)).toEqual(x.history)
    expect(x.stories.eventLog(x.story.id).slice(0, events.length)).toEqual(events)
    expect(x.stories.eventLog(x.story.id).find(event => event.seq === first.seq)).toMatchObject({ data: { parentPrompt: first.parentPrompt, writerPrompt: first.writerPrompt, systemPrompt: first.systemPrompt, writerSystemPrompt: first.writerSystemPrompt } })
    expect(rebound.withCheckpoint(before.checkpoint).writerPrompt).toBe(rebound.writerPrompt)
    expect(rebound.withCheckpoint(before.checkpoint).systemPrompt).toBe(rebound.systemPrompt)
    expect(rebound.withCheckpoint(before.checkpoint).writerSystemPrompt).toBe(rebound.writerSystemPrompt)
    expect(renamed.writerPrompt).toContain(x.history.text)
  })

  it.each(['unbound', 'deleted'] as const)('preserves the explicit cast when the persona is %s', state => {
    const x = setup(), saved = x.stories.snapshot(x.story.id)
    if (state === 'unbound') delete saved.profile.resources.persona
    if (state === 'deleted') x.assets.remove(x.first.id, x.first.revision)
    const context = x.contexts.preview(x.story.id, '', route, [], [], '', {}, saved.profile)
    expectParticipation(context, { playerCharacterId: saved.profile.playerCharacterId, cast: saved.profile.cast, scene: {} })
    expect(context.identities.userName).toBe('会话原名')
    expect(context.replyOptionsPlayer).toEqual({ characterId: 'player', name: '会话原名' })
    expect(context.sources.find(source => source.id === 'rp.persona')).toBeUndefined()
    if (state === 'deleted') expect(context.diagnostics.missing).toContainEqual(expect.objectContaining({ id: x.first.id, kind: 'persona' }))
  })

  it('projects a fresh name without mutating input snapshots or assigning an unconfigured player', () => {
    const x = setup(), saved = x.stories.snapshot(x.story.id), original = structuredClone(saved)
    const input = { story: saved, assets: [x.first, x.card], files: [], runId: '', model: route }
    const context = assembleContext(input)
    expect(context.systemPrompt).toContain(`"name":"${x.first.name}"`)
    expect(context.writerSystemPrompt).toContain(`"name":"${x.first.name}"`)
    expect(saved).toEqual(original)
    delete saved.profile.playerCharacterId
    saved.profile.cast = [{ characterId: 'npc', name: '旁观者', controller: 'agent' }]
    const withoutPlayer = assembleContext(input)
    expectParticipation(withoutPlayer, { cast: saved.profile.cast, scene: {} })
    expect(withoutPlayer.replyOptionsPlayer).toBeNull()
  })
})
