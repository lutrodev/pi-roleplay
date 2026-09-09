import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { SettingsService } from '../apps/server/src/services/settings-service.ts'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { DEFAULT_PREFERENCES, normalizePreferences } from '../packages/rp-core/src/settings/preferences.ts'
import { LEGACY_FEATURE_IDS, legacyPreferences } from './legacy-preferences.ts'
import { insertQuickReply, normalizeQuickReplies } from '../packages/rp-core/src/interaction/quick-replies.js'
import { normalizeReplyOptionsInput } from '../packages/rp-core/src/interaction/reply-options.js'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import { fixture, message, profile } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => { for (const item of fixtures.splice(0)) item.close() })
const route = { provider: 'synthetic', model: 'story' }
function setup() {
  const x = fixture(); fixtures.push(x)
  const models = new ModelRegistry([{ ...route, keyEnv: 'RP_TEST_KEY', api: 'openai-completions', baseUrl: 'https://model.test/v1', contextWindow: 32000, maxTokens: 8000 }], { env: () => 'synthetic-key' })
  return { ...x, models, settings: new SettingsService(x.assets, models) }
}

describe('single-user settings and effective feature policy', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])('upgrades v%s once, preserving supported typography, model, identity and enabled choices', version => {
    const x = setup(), preferences = { ...structuredClone(DEFAULT_PREFERENCES), language: 'en' as const, transcriptView: 'normal' as const, busyEnter: 'steer' as const,
      identity: '保留身份', mainModel: route, subagentsEnabled: false, quickRepliesEnabled: false, replyOptionsEnabled: false,
      reading: { ...DEFAULT_PREFERENCES.reading, dialogueHighlight: false, showAvatars: false, fontSize: 21, lineHeight: 2, maxWidth: 920, dialogueColor: 'rose' as const, fontFamily: 'serif' as const } }
    const old = legacyPreferences(preferences, version)
    const expected = { ...preferences, ...(version < 4 ? { language: 'zh' } : {}), ...(version < 3 ? { busyEnter: 'queue' } : {}), ...(version < 2 ? { transcriptView: 'compact' } : {}),
      reading: { ...preferences.reading, ...(version < 5 ? { fontFamily: 'sans' } : {}), ...(version < 6 ? { dialogueColor: 'green' } : {}) } }
    x.assets.setSetting('app.preferences', JSON.parse(JSON.stringify({ version, revision: 17, preferences: old })))
    const upgraded = x.settings.snapshot()
    expect(upgraded).toEqual({ version: 9, revision: 18, preferences: expected })
    expect(x.assets.getSetting('app.preferences')).toEqual(upgraded)
    expect(new SettingsService(x.assets, x.models).snapshot()).toEqual(upgraded)
    expect(() => x.settings.update(17, upgraded.preferences)).toThrow('已经更新')
    const saved = x.settings.update(18, { ...upgraded.preferences, language: 'zh' })
    expect(saved.preferences.mainModel).toEqual(route)
    expect(saved.preferences.reading.fontSize).toBe(21)
    expect(() => x.settings.update(saved.revision, { ...saved.preferences, language: 'fr' })).toThrow('界面语言')
    expect(() => x.settings.update(saved.revision, { ...saved.preferences, reading: { ...saved.preferences.reading, fontFamily: 'unknown' } })).toThrow('阅读设置')
  })

  it.each([true, false])('also retires the v6 icon-only switch (%s)', enabled => {
    const x = setup(), old = legacyPreferences(undefined, 6)
    if (enabled) old.enabledFeatures.push('compact-access-mode')
    x.assets.setSetting('app.preferences', JSON.parse(JSON.stringify({ version: 6, revision: 5, preferences: old })))
    expect(x.settings.snapshot()).toEqual({ version: 9, revision: 6, preferences: DEFAULT_PREFERENCES })
  })

  it('rejects invalid legacy settings without losing their original data', () => {
    const x = setup()
    for (const features of [[...LEGACY_FEATURE_IDS, 'unknown-feature'], [...LEGACY_FEATURE_IDS, 'compact-access-mode', 'compact-access-mode'], ['compat-mvu']]) {
      const old = JSON.parse(JSON.stringify({ version: 6, revision: 9, preferences: { ...legacyPreferences(undefined, 6), enabledFeatures: features } }))
      x.assets.setSetting('app.preferences', old)
      expect(() => x.settings.snapshot()).toThrow('设置已损坏')
      expect(x.assets.getSetting('app.preferences')).toEqual(old)
    }
  })

  it('saves only complete validated settings atomically and preserves choices across service reconstruction', () => {
    const x = setup(), initial = x.settings.snapshot(), prefs = structuredClone(initial.preferences)
    prefs.mainModel = route; prefs.replyOptions = { count: 2, maxCharacters: 40, keywords: ['  出海  ', '守塔'] }; prefs.quickReplies = []
    const saved = x.settings.update(initial.revision, prefs)
    expect(saved.preferences.replyOptions.keywords).toEqual(['出海', '守塔'])
    expect(new SettingsService(x.assets, x.models).snapshot()).toEqual(saved)
    expect(() => x.settings.update(initial.revision, prefs)).toThrow('已经更新')
    expect(() => x.settings.update(saved.revision, { ...prefs, replyOptions: { count: 3, maxCharacters: 40, keywords: ['缺一项', '缺一项'] } })).toThrow('回复选项')
    expect(() => x.settings.update(saved.revision, { ...prefs, password: 'should-never-save' })).toThrow('未知字段')
    expect(x.settings.snapshot()).toEqual(saved)
    expect(() => x.settings.update(saved.revision, { ...prefs, mainModel: { ...route, model: 'unconfigured' } })).toThrow('尚未在服务端配置')
    x.assets.setSetting('app.preferences', { version: 99 })
    expect(() => x.settings.snapshot()).toThrow('设置已损坏')
  })

  it('changes only UI preferences without rewriting materials, story history or model prompt text', () => {
    const x = setup(), config = profile()
    const card = x.assets.create('character', { name: '设置', description: '角色卡原文：灯塔保持明亮。', firstMessage: '门外有人。' })
    config.resources.card = { id: card.id }
    const story = x.stories.create('已完成', config), contexts = new ContextService(x.stories, x.assets)
    const before = contexts.preview(story.id, '草稿 {{char}}', route)
    const saved = x.settings.snapshot()
    x.settings.update(saved.revision, { ...saved.preferences, language: 'en' })
    const after = contexts.preview(story.id, '草稿 {{char}}', route)
    expect(after.parentPrompt).toBe(before.parentPrompt)
    expect(after.writerPrompt).toBe(before.writerPrompt)
    expect(after.systemPrompt).toBe(before.systemPrompt)
    expect(after.writerSystemPrompt).toBe(before.writerSystemPrompt)
    expect(x.stories.snapshot(story.id)).toEqual(story)
    expect(x.assets.get(card.id)).toEqual(card)
  })

  it('rejects retired gates and malformed optional-behavior preferences on current writes', () => {
    expect(() => normalizePreferences({ ...DEFAULT_PREFERENCES, enabledFeatures: [] })).toThrow('未知字段')
    expect(() => normalizePreferences({ ...DEFAULT_PREFERENCES, quickRepliesEnabled: 'false' })).toThrow('布尔值')
    expect(() => normalizePreferences({ ...DEFAULT_PREFERENCES, reading: { ...DEFAULT_PREFERENCES.reading, showStateCard: 0 } })).toThrow('布尔值')
  })

  it('excludes unselected material and paused story state from actual prompts and commits', async () => {
    const x = setup(), config = profile(), card = x.assets.create('character', { name: '灯塔人', description: 'DISABLED_CHARACTER_TEXT' })
    const book = x.assets.create('lorebook', { name: '世界', entries: [{ id: 'rule', name: '门', level: 'worldDescription', content: 'DISABLED_STATE_CONDITION_TEXT', enabled: true, constant: true, stateCondition: 'state("story", "/energy") > 1' }] })
    config.resources.lorebooks = [{ id: book.id }]; config.variables = { enabled: false, mvu: true }
    const definition = { title: '故事', updateMode: 'rules-required', schema: { type: 'object', properties: { energy: { type: 'number' } }, required: ['energy'] }, rules: [{ id: 'energy', target: '/energy', when: '每轮检查', cadence: 'every-turn', effect: { op: 'increment' } }] }
    const state = { namespaces: { story: createNamespaceSnapshot({ definition, initialValue: { energy: 10 } }) } }
    const story = x.stories.create('可暂停功能', config, state), service = new StoryService(x.stories, x.assets, x.files)
    const run = service.send(story.id, 'feature-policy', [{ text: '继续', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running')
    const context = new ContextService(x.stories, x.assets).freeze(run.id, route, [], [], '', { identity: '自定义身份 {{model}}' })
    expect(context.writerPrompt).not.toContain('DISABLED_CHARACTER_TEXT'); expect(context.writerPrompt).not.toContain('DISABLED_STATE_CONDITION_TEXT')
    expect(context.parentPrompt).not.toContain('state_commit_contract'); expect(context.systemPrompt).toContain('自定义身份 story')
    expect(context.diagnostics.missing).toEqual([])
    const turns = new TurnService(x.stories)
    turns.recordWriter(run.id, 'writer', context.seq, '灯塔依然亮着。')
    await expect(turns.commit(run.id, randomUUID(), '', { effects: [{ kind: 'state.update' }] })).rejects.toThrow('未启用变量维护')
    await turns.commit(run.id, randomUUID(), '', {})
    expect(x.stories.snapshot(story.id).state).toEqual(state)
    expect(x.stories.snapshot(story.id).profile.resources).toEqual(config.resources)
    const empty = new StoryService(x.stories, x.assets, x.files).create('自由对话', {}, false)
    expect(empty.profile.resources).toEqual({ lorebooks: [], writingStyles: [] })
  })

  it('migrates a disabled card to an unbound selection without changing the opening or other saved data', () => {
    const x = setup(), card = x.assets.create('character', { name: '灯塔人', firstMessage: '{{char}} 向 {{user}} 点头。' })
    const service = new StoryService(x.stories, x.assets, x.files)
    const story = service.create('开场保留', { scene: { openingSource: 'card' }, resources: { card: { id: card.id }, lorebooks: [], writingStyles: [] } })
    const before = x.stories.eventLog(story.id), old = legacyPreferences()
    old.enabledFeatures = old.enabledFeatures.filter(id => !['character-card', 'compat-mvu'].includes(id))
    x.assets.setSetting('app.preferences', JSON.parse(JSON.stringify({ version: 7, revision: 2, preferences: old })))
    x.settings.snapshot()
    const migrated = x.stories.snapshot(story.id)
    expect(migrated.profile.resources.card).toBeUndefined()
    expect(migrated.messages).toEqual(story.messages)
    expect(migrated.state).toEqual(story.state)
    expect(x.stories.eventLog(story.id).slice(0, before.length)).toEqual(before)
    const next = service.updateProfile(story.id, migrated.revision, { ...migrated.profile, resources: { ...migrated.profile.resources, persona: undefined } })
    expect(next.messages).toEqual(story.messages)
    expect(next.state).toEqual(story.state)
    expect(next.profile.resources.persona).toBeUndefined()
    expect(x.assets.get(card.id)).toEqual(card)
  })

})

describe('quick replies and advisory reply option protocol', () => {
  it('wraps a selection, places a caret without splitting Unicode, and rejects duplicate or over-limit settings', () => {
    expect(insertQuickReply('他说你好', '“”', { start: 2, end: 4 }, 'middle')).toEqual({ text: '他说“你好”', selection: { start: 3, end: 3 } })
    expect(insertQuickReply('', '😀😃', { start: 0, end: 0 }, 'middle')).toEqual({ text: '😀😃', selection: { start: 2, end: 2 } })
    expect(insertQuickReply('草稿', '继续', { start: 2, end: 2 }, 'end').text).toBe('草稿继续')
    expect(() => normalizeQuickReplies([{ id: 'a', label: 'A', content: '一' }, { id: 'b', label: 'a', content: '二' }])).toThrow('unique')
    expect(() => normalizeQuickReplies([{ id: 'long', label: '过长', content: '界'.repeat(2001) }])).toThrow('2000')
  })
  it('canonicalizes useful options without making harmless annotations a narrative failure', () => {
    expect(normalizeReplyOptionsInput({ note: '额外说明', options: ['  他走出去。 ', '', '他走出去。', '他回到窗边。', '多余选项。'] }, 2).options).toEqual(['他走出去。', '他回到窗边。'])
    expect(() => normalizeReplyOptionsInput({ options: ['', ' '] })).toThrow('usable')
  })
})
