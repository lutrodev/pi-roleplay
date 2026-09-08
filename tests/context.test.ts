import { afterEach, describe, expect, it } from 'vitest'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { parseCharacterCardFile } from '../packages/rp-core/src/character/character-card.js'
import { stateContext } from '../packages/rp-core/src/context/state.ts'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import type { ContextSlot, JsonObject, StoryProfile } from '../packages/rp-core/src/types.ts'
import { fixture, message, profile } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(item => item.close()))
const model = { provider: 'test', model: 'test-model' }
function setup(config: StoryProfile = profile()) {
  const x = fixture(); fixtures.push(x)
  const story = x.stories.create('上下文测试', config)
  const service = new StoryService(x.stories, x.assets, x.files)
  const contexts = new ContextService(x.stories, x.assets)
  return { ...x, story, service, contexts }
}

describe('frozen RP request context', () => {
  it.each([true, false])('keeps recency notes and the summary in its moved slot with section tags %s, including overflow rebuilds', sectionTag => {
    const x = setup(), old = message('assistant', '旧正文', { kind: 'narrative' }), recent = message('assistant', '最新正文 {{char}}', { kind: 'narrative' })
    for (const item of [old, recent]) x.stories.append(x.story.id, { type: 'message.added', data: { message: item } })
    const baseline = x.contexts.preview(x.story.id, '', model)
    expect(baseline.writerPrompt).not.toContain('compressed record')
    const summarySlot = baseline.layout.slots.find(slot => slot.sourceIds.includes('rp.conversation-summary'))!
    const slots = baseline.layout.slots.filter(slot => slot !== summarySlot)
    slots.splice(slots.findIndex(slot => slot.sourceIds.includes('rp.conversation')) + 1, 0, { ...summarySlot, sectionTag })
    x.service.updateProfile(x.story.id, x.stories.snapshot(x.story.id).revision, { ...x.story.profile, contextBuild: { version: 1, slots } })
    const run = x.service.send(x.story.id, 'next', [{ text: '本轮续写输入', attachmentIds: [] }]).run
    const context = x.contexts.preview(x.story.id, run.id, model)
    const checkpoint = { throughMessageId: old.id, sourceMessageIds: [old.id], text: '总结原文 {{char}}' }
    const rebuilt = context.withCheckpoint(checkpoint)
    x.stories.append(x.story.id, { type: 'summary.created', data: checkpoint })
    const fresh = x.contexts.preview(x.story.id, run.id, model)
    for (const result of [rebuilt, fresh]) {
      expect(result.writerPrompt.match(/总结原文/g)).toHaveLength(1)
      expect(result.writerPrompt).toContain('总结原文 {{char}}')
      expect(result.writerPrompt).toContain('Newer Conversation History takes precedence.')
      expect(result.writerPrompt).toContain('This original text takes precedence over Conversation Summary.')
      expect(result.writerPrompt).toContain('Entries labeled narrative are successfully committed story prose.')
      expect(result.writerPrompt.indexOf('最新正文')).toBeLessThan(result.writerPrompt.indexOf('总结原文'))
      expect(result.writerPrompt.indexOf('总结原文')).toBeLessThan(result.writerPrompt.indexOf('本轮续写输入'))
      expect(result.writerPrompt).not.toContain('旧正文')
      expect(result.catalog.find(item => item.id === 'rp.conversation-summary')).toMatchObject({ label: '会话总结', required: true, idleAllowed: false })
    }
  })

  it('preserves independent preset fields and writing styles, expands identities once, and inserts current input once', () => {
    const x = setup()
    const preset = x.assets.create('preset', { name: '测试预设', fields: [
      { name: '开头', content: '首部提示 {{char}} 对 {{user}}', position: 'top' },
      { name: '尾部', content: '末尾提示', position: 'bottom', sectionTag: false },
    ] })
    const styleA = x.assets.create('writingStyle', { name: '简洁', content: '独立文风甲' })
    const styleB = x.assets.create('writingStyle', { name: '节奏', content: '独立文风乙' })
    const persona = x.assets.create('persona', { name: '阿舟', description: '旅行者' })
    const card = x.assets.create('character', { name: '守塔人', description: '守候海岸' })
    const config = { ...x.story.profile, resources: { card: { id: card.id }, persona: { id: persona.id }, preset: { id: preset.id }, lorebooks: [], writingStyles: [{ id: styleA.id }, { id: styleB.id }] } }
    x.service.updateProfile(x.story.id, x.story.revision, config)
    x.stories.append(x.story.id, { type: 'message.added', data: { message: message('assistant', '历史 {{char}} 保持原样', { kind: 'narrative' }) } })
    const run = x.service.send(x.story.id, 'send-1', [{ text: '唯一的本轮请求', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running')
    const context = x.contexts.freeze(run.id, model)
    expect(context.writerPrompt).toContain('首部提示 守塔人 对 阿舟')
    expect(context.writerPrompt).toContain('历史 {{char}} 保持原样')
    expect(context.writerPrompt.match(/唯一的本轮请求/g)).toHaveLength(1)
    expect(context.writerPrompt.indexOf('独立文风甲')).toBeLessThan(context.writerPrompt.indexOf('独立文风乙'))
    expect(context.writerPrompt.indexOf('独立文风乙')).toBeLessThan(context.writerPrompt.indexOf('唯一的本轮请求'))
    expect(context.writerPrompt.trimEnd().endsWith('末尾提示')).toBe(true)
    expect(context.parentPrompt).toContain('阿舟')
    expect(context.parentPrompt).not.toContain('独立文风甲')
    expect(context.sources.filter(item => String(item.id).startsWith('rp.preset:'))).toHaveLength(2)
    expect(context.sources.filter(item => String(item.id).startsWith('rp.writing-style:'))).toHaveLength(2)
    expect(context.sourceMessageIds).toHaveLength(2)
  })

  it('keeps frozen content after asset edits; next assembly resolves current revisions and reports deleted bindings', () => {
    const x = setup()
    const card = x.assets.create('character', { name: '守塔人', description: '旧设定' })
    x.service.updateProfile(x.story.id, x.story.revision, { ...x.story.profile, resources: { ...x.story.profile.resources, card: { id: card.id } } })
    const run = x.service.send(x.story.id, 'send-1', [{ text: '继续', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running')
    const first = x.contexts.freeze(run.id, model)
    x.assets.update(card.id, 1, { name: '守塔人', description: '新设定' })
    const next = x.contexts.preview(x.story.id, run.id, model)
    expect(first.writerPrompt).toContain('旧设定')
    expect(next.writerPrompt).toContain('新设定')
    const event = x.stories.eventLog(x.story.id).find(item => item.seq === first.seq)
    expect(event?.type === 'context.built' && event.data.writerPrompt).toContain('旧设定')
    x.assets.remove(card.id, 2)
    expect(x.contexts.preview(x.story.id, run.id, model).diagnostics.missing).toEqual([expect.objectContaining({ id: card.id })])
    expect(x.stories.snapshot(x.story.id).profile.resources.card?.id).toBe(card.id)
  })

  it('supports custom slots, idle sources, reordering and active-current-input validation', () => {
    const x = setup()
    const style = x.assets.create('writingStyle', { name: '可停用', content: '不应出现' })
    const config = x.story.profile
    config.resources.writingStyles = [{ id: style.id }]
    config.contextBuild = { version: 1, slots: [
      { id: 'custom-first', label: '自定义', sourceIds: ['rp.custom:custom-first'] },
      { id: `rp.writing-style:${style.id}`, label: '停用', sourceIds: [`rp.writing-style:${style.id}`], idle: true },
    ], customSources: [{ slotId: 'custom-first', content: '自定义规则内容' }] }
    x.service.updateProfile(x.story.id, x.story.revision, config)
    const run = x.service.send(x.story.id, 'one', [{ text: '继续', attachmentIds: [] }]).run
    const context = x.contexts.preview(x.story.id, run.id, model)
    expect(context.writerPrompt).toContain('自定义规则内容')
    expect(context.writerPrompt).not.toContain('不应出现')
    const slots = context.layout.slots as ContextSlot[]
    x.stories.append(x.story.id, { type: 'profile.changed', data: { profile: { ...config, contextBuild: {
      version: 1, slots: slots.map(slot => slot.sourceIds.includes('rp.current-input') ? { ...slot, idle: true } : slot), customSources: config.contextBuild.customSources,
    } } } })
    expect(() => x.contexts.preview(x.story.id, run.id, model)).toThrow('cannot be idle')
  })

  it('activates lore with per-book scan depth and state gates, forwards readonly attachment paths, and excludes raw quarantined prompts', () => {
    const x = setup()
    const parsed = parseCharacterCardFile(Buffer.from(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
      name: '守塔人', description: '海岸', system_prompt: '隔离中的指令', character_book: { entries: [] },
    } })), 'card.json', { maxTextCharacters: 2_000_000 })
    const { card } = x.assets.importCharacter(parsed)
    const lore = x.assets.create('lorebook', { name: '海岸资料', scanDepth: 0, entries: [
      { id: 'coast', keys: ['海岸'], content: '当轮激活的设定' },
      { id: 'old', keys: ['旧关键词'], content: '超出扫描深度' },
      { id: 'blocked', constant: true, content: '条件不成立内容', stateCondition: 'false' },
    ] })
    x.service.updateProfile(x.story.id, x.story.revision, { ...x.story.profile, resources: { ...x.story.profile.resources, card: { id: card.id }, lorebooks: [{ id: lore.id }] } })
    x.stories.append(x.story.id, { type: 'message.added', data: { message: message('assistant', '旧关键词') } })
    const file = x.files.save(Buffer.from('地图'), '地图.txt', 'text/plain')
    const run = x.service.send(x.story.id, 'one', [{ text: '走上海岸', attachmentIds: [file.id] }]).run
    const context = x.contexts.preview(x.story.id, run.id, model, [file])
    expect(context.writerPrompt).toContain('当轮激活的设定')
    expect(context.writerPrompt).not.toContain('超出扫描深度')
    expect(context.writerPrompt).not.toContain('条件不成立内容')
    expect(context.writerPrompt).not.toContain('隔离中的指令')
    expect(context.writerPrompt).toContain(`/inputs/${file.storageKey}`)
    expect(context.files).toEqual([file])
    const quarantined = card.data.quarantinedPrompts as JsonObject[]
    x.assets.update(card.id, 1, { name: card.name, description: '海岸', acceptedPromptPaths: [quarantined[0]!.path] })
    expect(x.contexts.preview(x.story.id, run.id, model).writerPrompt).toContain('trusted_instruction: 隔离中的指令')
  })

  it('replaces summarized history with its checkpoint and restores full history after source edits', () => {
    const x = setup()
    const first = message('assistant', '旧章节正文')
    x.stories.append(x.story.id, { type: 'message.added', data: { message: first } })
    x.stories.append(x.story.id, { type: 'summary.created', data: { throughMessageId: first.id, text: '前情归纳', sourceMessageIds: [first.id] } })
    const run = x.service.send(x.story.id, 'one', [{ text: '下一章', attachmentIds: [] }]).run
    let context = x.contexts.preview(x.story.id, run.id, model)
    expect(context.writerPrompt).toContain('前情归纳')
    expect(context.writerPrompt).not.toContain('旧章节正文')
    expect(context.sourceMessageIds).not.toContain(first.id)
    x.stories.append(x.story.id, { type: 'message.edited', data: { messageId: first.id, text: '已修改的章节' } })
    context = x.contexts.preview(x.story.id, run.id, model)
    expect(context.writerPrompt).toContain('已修改的章节')
    expect(context.writerPrompt).not.toContain('前情归纳')
  })

  it('separates Writer facts from the parent state-update protocol and supplies an empty replacement contract', () => {
    const state = { namespaces: { story: createNamespaceSnapshot({ definition: { title: '精力', updateMode: 'schema-only', rules: [],
      schema: { type: 'object', properties: { energy: { type: 'number' } } },
    }, initialValue: { energy: 10 } }) } }
    const context = stateContext(state)
    expect(context.text).not.toContain('expectedRevision')
    expect(context.parentText).toContain('expectedRevision')
    expect(JSON.parse(stateContext({ namespaces: {} }).parentText).state_commit_contract.namespaces).toEqual([])
  })

  it('delivers imported MVU group and concrete rules together in schema-only mode and accepts their resulting update', async () => {
    const x = setup(), semantic = '每次搬动箱子后，所有 count 必须在原值上增加7。'
    const imported = x.assets.importCharacter(parseCharacterCardFile(Buffer.from(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
      name: '管理员', extensions: { stat_data: { entries: [{ count: 0 }, { count: 2 }], energy: 10 } },
      character_book: { entries: [{ id: 1, comment: '[mvu_update]变量更新规则', constant: true, enabled: true,
        content: `变量更新规则:\n  'entries.*.count':\n    type: number\n    check: ${semantic}\n  energy:\n    type: number\n    check: 搬箱后精力减少2。` }] },
    } })), 'group-rules.json', { maxTextCharacters: 2_000_000 }))
    const story = x.service.create('分组规则', { resources: { card: { id: imported.card.id }, lorebooks: [{ id: imported.lorebook!.id }], writingStyles: [] } }, false)
    const run = x.service.send(story.id, 'group', [{ text: '管理员搬动一次箱子。', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running')
    const frozen = x.contexts.freeze(run.id, model), snapshot = story.state.namespaces.story!
    expect(snapshot.definition.updateMode).toBe('schema-only')
    expect(frozen.parentPrompt).toContain(semantic)
    expect(frozen.parentPrompt).toContain('entries.*.count')
    expect(frozen.parentPrompt).toContain('搬箱后精力减少2。')
    expect(frozen.writerPrompt).not.toContain(semantic)
    expect(frozen.writerPrompt).not.toContain('state_commit_contract')
    const contract = JSON.parse(stateContext(story.state).parentText).state_commit_contract.namespaces[0]
    expect(contract.rules).toHaveLength(2)
    expect(contract.ruleGuidance).toContain('ruleId is optional')
    expect(contract.schema).toEqual(snapshot.definition.schema)
    const turns = new TurnService(x.stories)
    turns.recordWriter(run.id, 'writer', frozen.seq, '管理员将一只箱子搬到门边。')
    await turns.commit(run.id, 'narrative', '', { effects: [{ kind: 'state.update', namespace: 'story', expectedRevision: 1,
      payload: { changes: [{ op: 'set', path: '/entries', value: [{ count: 7 }, { count: 9 }], reason: semantic },
        { op: 'increment', path: '/energy', by: -2, reason: '搬箱消耗' }] } }] })
    expect(x.stories.snapshot(story.id).state.namespaces.story!.value).toEqual({ entries: [{ count: 7 }, { count: 9 }], energy: 8 })
    const disabled = structuredClone(story.state); disabled.namespaces.story!.definition.updateMode = 'disabled'
    expect(JSON.parse(stateContext(disabled).parentText).state_commit_contract.namespaces[0].rules).toBeUndefined()
  })
})
