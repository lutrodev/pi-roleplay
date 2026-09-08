import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FileService } from '../apps/server/src/services/file-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { SkillService } from '../apps/server/src/services/skill-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { RoleplayTools } from '../apps/server/src/runtime/roleplay-tools.ts'
import { SkillSession } from '../apps/server/src/runtime/skills.ts'
import { ToolClient } from '../apps/server/src/runtime/tool-client.ts'
import type { RuntimeToolScope } from '../apps/server/src/runtime/executor.ts'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ExecutionMode, JsonObject } from '../packages/rp-core/src/types.ts'
import { fixture, message, profile } from './helpers.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
const definition = { title: '精力', updateMode: 'schema-only', schema: { type: 'object', properties: { energy: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['energy'], additionalProperties: false }, rules: [] }

async function setup(mode: ExecutionMode = 'agent') {
  const x = fixture(); cleanup.push(x.close)
  const config = profile(); config.runtime.executionMode = mode
  const story = x.stories.create('资料工具', config)
  const service = new StoryService(x.stories, x.assets, x.files), turns = new TurnService(x.stories), files = new FileService(x.files, x.assets, x.stories)
  const run = service.send(story.id, randomUUID(), [{ text: '请保存我要求的资料和变量。', attachmentIds: [] }]).run
  x.stories.setRunStatus(run.id, 'running')
  const owner = message('assistant', '执行资料操作。', { kind: 'tool', runId: run.id, turnId: run.turnId })
  x.stories.append(story.id, { type: 'message.added', data: { message: owner } })
  const skills = new SkillSession(await new SkillService([{ path: fileURLToPath(new URL('../skills/builtin', import.meta.url)), virtualPath: '/skills/builtin' }]).snapshot())
  const controller = new AbortController()
  const scope: RuntimeToolScope = { run, signal: controller.signal, owner: () => owner.id, writerText: () => null,
    refreshContext: () => { new ContextService(x.stories, x.assets).freeze(run.id, { provider: 'test', model: 'test' }, [], [], skills.parentInstructions) } }
  const client = new ToolClient('http://tools.test', 'synthetic-tool-token-0123456789abcdef', async () => { throw new Error('Unexpected file transport') })
  const rp = new RoleplayTools(service, turns, files, client, skills)
  const tools = mode === 'agent' ? rp.agent(scope) : rp.read(run)
  return { ...x, story, run, owner, service, turns, filesService: files, skills, scope, controller, client, rp, tools }
}
async function call(tools: AgentTool[], name: string, input: object): Promise<JsonObject> {
  const result = await tools.find(tool => tool.name === name)!.execute(randomUUID(), input, new AbortController().signal)
  return result.details as JsonObject
}
async function load(skills: SkillSession, ...names: string[]) { for (const name of names) await skills.tool().execute(randomUUID(), { name }, new AbortController().signal) }

describe('model-facing RP material and state tools', () => {
  it('limits Chat reads to bound IDs and never exposes quarantined prompt bodies or source payloads', async () => {
    const x = await setup('chat')
    const card = (await x.filesService.importCharacter(Buffer.from(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '守塔人', description: '海岸', system_prompt: 'quarantined-secret-instruction' } })), 'card.json')).card
    const other = x.assets.create('character', { name: '陌生人' })
    const current = x.stories.snapshot(x.story.id).profile
    x.stories.append(x.story.id, { type: 'profile.changed', data: { profile: { ...current, revision: current.revision + 1, resources: { ...current.resources, card: { id: card.id } } } } })
    const list = await call(x.tools, 'rp_asset_read', { action: 'list', kind: 'character' })
    expect(list.scope).toBe('current_session')
    expect((list.page as JsonObject).total).toBe(1)
    expect(JSON.stringify(list)).not.toContain(other.id)
    const read = await call(x.tools, 'rp_asset_read', { action: 'get', kind: 'character', id: card.id })
    expect(JSON.stringify(read)).toContain('quarantined')
    expect(JSON.stringify(read)).not.toContain('quarantined-secret-instruction')
    expect(JSON.stringify(read)).not.toContain('sourcePayload')
    await expect(call(x.tools, 'rp_asset_read', { action: 'get', kind: 'character', id: other.id })).rejects.toThrow('RP_ASSET_NOT_BOUND')
    expect(x.tools.map(tool => tool.name)).toEqual(['rp_asset_read', 'rp_state_read'])
  })

  it('requires the matching guide, preserves character patch fields and rejects stale revisions and model trust changes', async () => {
    const x = await setup(), card = x.assets.create('character', { name: '守塔人', description: '旧描述', personality: '寡言', creator: '原作者', extensions: { source: '保留' } })
    const request = { action: 'update', kind: 'character', id: card.id, expectedRevision: 1, value: { description: '新描述' } }
    await expect(call(x.tools, 'rp_asset', request)).rejects.toThrow('SKILL_REQUIRED')
    expect(() => x.rp.assertReady()).toThrow('尚未完成')
    expect(x.assets.get(card.id).revision).toBe(1)
    await load(x.skills, 'rp-guide-character-card')
    expect((await call(x.tools, 'rp_asset', request)).ok).toBe(true)
    expect(x.assets.get(card.id).data).toMatchObject({ name: '守塔人', description: '新描述', personality: '寡言', creator: '原作者', extensions: { source: '保留' } })
    expect(() => x.rp.assertReady()).not.toThrow()
    await expect(call(x.tools, 'rp_asset', request)).rejects.toThrow('REVISION_CONFLICT')
    await expect(call(x.tools, 'rp_asset', { ...request, expectedRevision: 2, value: { acceptedPromptPaths: ['/data/system_prompt'] } })).rejects.toThrow('INVALID_ASSET_FIELDS')
    expect(x.assets.get(card.id).revision).toBe(2)
  })

  it('validates native lore fields and requires the state guide for newly configured conditions', async () => {
    const x = await setup(); await load(x.skills, 'rp-guide-lorebook')
    const entry = { id: 'harbor', name: '雾港', content: '港口终年有雾。', level: 'worldDescription', constant: true }
    const create = (value: object) => call(x.tools, 'rp_asset', { action: 'create', kind: 'lorebook', value })
    await expect(create({ name: '海岸', entries: [{ ...entry, name: undefined }] })).rejects.toThrow('name')
    await expect(create({ name: '海岸', entries: [{ ...entry, always: true }] })).rejects.toThrow('INVALID_ASSET_FIELDS')
    await expect(create({ name: '海岸', entries: [{ ...entry, constant: false, secondaryKeys: ['雾'] }] })).rejects.toThrow('主关键词')
    const conditional = { ...entry, stateCondition: 'state("story", "/energy") > 0' }
    await expect(create({ name: '海岸', entries: [conditional] })).rejects.toThrow('SKILL_REQUIRED')
    await load(x.skills, 'rp-guide-state')
    const result = await create({ name: '海岸', entries: [conditional] }), asset = result.asset as JsonObject
    await call(x.tools, 'rp_asset', { action: 'update', kind: 'lorebook', id: asset.id, expectedRevision: 1, value: { name: '雾港资料' } })
    expect(x.assets.get(String(asset.id)).data.entries).toEqual(expect.arrayContaining([expect.objectContaining(conditional)]))
    expect(x.assets.list('lorebook')).toHaveLength(1)
  })

  it('keeps a successful asset write visible if context refresh fails, then recovers by binding without recreating', async () => {
    const x = await setup(); await load(x.skills, 'rp-guide-writing-style')
    const refresh = x.scope.refreshContext
    x.scope.refreshContext = () => { throw new Error('Synthetic context failure') }
    const result = await call(x.tools, 'rp_asset', { action: 'create', kind: 'writingStyle', value: { name: '简洁', content: '少用修饰。' }, bindToCurrentSession: true })
    expect(result.ok).toBe(false)
    const asset = result.asset as JsonObject
    expect(result.phases).toMatchObject({ assetWrite: { durable: true }, binding: { durable: true }, contextRefresh: { status: 'failed' } })
    expect(x.assets.get(String(asset.id)).revision).toBe(1)
    expect(() => x.rp.assertReady()).toThrow('尚未完成')
    x.scope.refreshContext = refresh
    await call(x.tools, 'rp_asset', { action: 'bind', changes: { writingStyleIds: [asset.id] } })
    expect(x.assets.list('writingStyle')).toHaveLength(1)
    expect(() => x.rp.assertReady()).not.toThrow()
    const profile = x.stories.snapshot(x.story.id).profile
    const before = profile.revision
    await expect(call(x.tools, 'rp_asset', { action: 'bind', changes: { writingStyleIds: [asset.id, randomUUID()] } })).rejects.toThrow('ASSET_NOT_FOUND')
    expect(x.stories.snapshot(x.story.id).profile.revision).toBe(before)
  })

  it('owns configuration by the assistant reply, keeps full-definition CAS, and retracts it when that reply is deleted', async () => {
    const x = await setup(); await load(x.skills, 'rp-guide-state')
    await call(x.tools, 'rp_state', { action: 'create', namespace: 'story', expectedRevision: 0, definition, initialValue: { energy: 50 } })
    const read = await call(x.tools, 'rp_state_read', { action: 'get', namespace: 'story' })
    expect(read).toMatchObject({ revision: 1, initialValue: { energy: 50 }, value: { energy: 50 }, definition })
    await expect(call(x.tools, 'rp_state', { action: 'reset', namespace: 'story', expectedRevision: 9 })).rejects.toThrow('STATE_REVISION_CONFLICT')
    expect(() => x.turns.configureState(x.run.id, x.owner.id, { operation: 'update', namespace: 'story', expectedRevision: 1, value: { energy: 30 } })).toThrow('完整的变量定义')
    await call(x.tools, 'rp_state', { action: 'update', namespace: 'story', expectedRevision: 1, definition, value: { energy: 30 } })
    await call(x.tools, 'rp_state', { action: 'reset', namespace: 'story', expectedRevision: 2 })
    expect(x.stories.snapshot(x.story.id).state.namespaces.story?.value).toEqual({ energy: 50 })
    x.stories.setRunStatus(x.run.id, 'completed')
    const edited = x.service.edit(x.story.id, x.stories.snapshot(x.story.id).revision, x.owner.id, '修改说明文字')
    expect(edited.state.namespaces.story?.value).toEqual({ energy: 50 })
    expect(x.service.remove(x.story.id, edited.revision, x.owner.id).state.namespaces).toEqual({})
  })

  it('rejects configuration without an owned assistant reply and validates the create revision', async () => {
    const x = await setup()
    expect(() => x.turns.configureState(x.run.id, randomUUID(), { operation: 'create', namespace: 'story', expectedRevision: 0, definition, initialValue: { energy: 50 } })).toThrow('对应的工具调用消息')
    expect(() => x.turns.configureState(x.run.id, x.owner.id, { operation: 'create', namespace: 'story', expectedRevision: 1, definition, initialValue: { energy: 50 } })).toThrow('版本必须为 0')
    expect(x.stories.snapshot(x.story.id).state.namespaces).toEqual({})
  })
})
