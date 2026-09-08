import { afterEach, describe, expect, it } from 'vitest'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { SettingsService } from '../apps/server/src/services/settings-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { AssetRepository } from '../apps/server/src/storage/asset-repository.ts'
import { StoryRepository } from '../apps/server/src/storage/story-repository.ts'
import { parseCharacterCardFile } from '../packages/rp-core/src/character/character-card.js'
import { storyVariables } from '../packages/rp-core/src/story/variables.ts'
import { normalizeProfile } from '../packages/rp-core/src/story/profile.js'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import { fixture, message, profile } from './helpers.ts'
import { legacyPreferences } from './legacy-preferences.ts'

const clean: (() => void)[] = []
afterEach(() => clean.splice(0).reverse().forEach(close => close()))
const route = { provider: 'test', model: 'test' }
function setup() {
  const x = fixture(); clean.push(x.close)
  const models = new ModelRegistry([])
  return { ...x, models, settings: new SettingsService(x.assets, models), service: new StoryService(x.stories, x.assets, x.files), contexts: new ContextService(x.stories, x.assets) }
}
const bootstrap = () => ({ namespaces: { story: createNamespaceSnapshot({ initialValue: { energy: 10 }, definition: { title: '精力', schema: { type: 'object', properties: { energy: { type: 'integer' } } }, updateMode: 'schema-only', rules: [] } }) } })

describe('settings ownership and persisted upgrades', () => {
  it('migrates disabled material and variable choices for active and archived stories, preserves history, and survives reopening', () => {
    const x = setup(), card = x.assets.create('character', { name: '守塔人', description: 'RETIRED_CARD_TEXT' })
    const persona = x.assets.create('persona', { name: '旅人', description: 'RETIRED_PERSONA_TEXT' })
    const book = x.assets.create('lorebook', { name: '海岸', entries: [{ id: 'all', constant: true, content: 'RETIRED_LORE_TEXT' }] })
    const preset = x.assets.create('preset', { name: '约定', fields: [{ name: '规则', content: 'RETIRED_PRESET_TEXT', position: 'top' }] })
    const style = x.assets.create('writingStyle', { name: '文风', content: 'RETIRED_STYLE_TEXT' })
    const resources = { card: { id: card.id }, persona: { id: persona.id }, preset: { id: preset.id }, lorebooks: [{ id: book.id }], writingStyles: [{ id: style.id }] }
    const originals = [false, true].map(archived => {
      const story = x.stories.create(archived ? '归档' : '当前', { ...profile(), resources }, bootstrap())
      x.stories.append(story.id, { type: 'message.added', data: { message: message('assistant', '已经写好的正文。', { kind: 'narrative' }) } })
      if (archived) x.service.archive(story.id, x.stories.latestSequence(story.id), true)
      return { story: x.stories.snapshot(story.id), events: x.stories.eventLog(story.id) }
    })
    const old = legacyPreferences(); old.enabledFeatures = ['quick-replies']
    x.assets.setSetting('app.preferences', JSON.parse(JSON.stringify({ version: 7, revision: 10, preferences: old })))
    const preferences = x.settings.snapshot()
    expect(preferences.preferences).toMatchObject({ quickRepliesEnabled: true, replyOptionsEnabled: false, subagentsEnabled: false, reading: { showStateCard: false, showAvatars: false, dialogueHighlight: false } })
    for (const { story, events } of originals) {
      const next = x.stories.snapshot(story.id)
      expect(next.profile.resources).toEqual({ lorebooks: [], writingStyles: [] })
      expect(storyVariables(next.profile)).toEqual({ enabled: false, mvu: false })
      expect(next.messages).toEqual(story.messages); expect(next.state).toEqual(story.state); expect(next.archived).toBe(story.archived)
      expect(x.stories.eventLog(story.id).slice(0, -1)).toEqual(events)
      const context = x.contexts.preview(story.id, '', route)
      expect(context.writerPrompt).not.toContain('RETIRED_'); expect(context.parentPrompt).not.toContain('state_commit_contract')
    }
    for (const asset of [card, persona, book, preset, style]) expect(x.assets.get(asset.id)).toEqual(asset)
    const database = new AppDatabase(x.filename); clean.push(() => database.close())
    const reopened = new SettingsService(new AssetRepository(database), x.models)
    expect(reopened.snapshot()).toEqual(preferences)
    for (const { story, events } of originals) expect(new StoryRepository(database).eventLog(story.id)).toHaveLength(events.length + 1)
    const fresh = x.service.create('新会话')
    expect(storyVariables(fresh.profile)).toEqual({ enabled: true, mvu: true })
    expect(fresh.profile.resources.persona).toBeDefined()
    const branch = x.service.fork(originals[0]!.story.id, x.stories.latestSequence(originals[0]!.story.id), originals[0]!.story.messages[0]!.id)
    expect(storyVariables(branch.profile)).toEqual({ enabled: false, mvu: false })
    expect(branch.profile.resources).toEqual({ lorebooks: [], writingStyles: [] })
  })

  it('rolls back the entire settings/story migration on failure and can retry without duplicate events', () => {
    const x = setup(), first = x.service.create('一'), second = x.service.create('二'), old = legacyPreferences()
    old.enabledFeatures = []
    x.assets.setSetting('app.preferences', JSON.parse(JSON.stringify({ version: 7, revision: 4, preferences: old })))
    const before = [first, second].map(story => x.stories.eventLog(story.id))
    x.database.sqlite.exec("CREATE TRIGGER migration_failure BEFORE INSERT ON events WHEN NEW.type = 'profile.changed' BEGIN SELECT RAISE(ABORT, 'synthetic migration fault'); END")
    expect(() => x.settings.snapshot()).toThrow('设置已损坏')
    expect(x.assets.getSetting('app.preferences')).toMatchObject({ version: 7, revision: 4 })
    expect([first, second].map(story => x.stories.eventLog(story.id))).toEqual(before)
    x.database.sqlite.exec('DROP TRIGGER migration_failure')
    expect(x.settings.snapshot().version).toBe(8); x.settings.snapshot()
    for (const [index, story] of [first, second].entries()) expect(x.stories.eventLog(story.id)).toHaveLength(before[index]!.length + 1)
  })
})

describe('per-story variables and MVU', () => {
  it('can unbind a source character card while preserving its existing opening and variables', () => {
    const x = setup(), parsed = parseCharacterCardFile(Buffer.from(JSON.stringify({ spec: 'chara_card_v3', data: { name: '守灯人', first_mes: '<initvar>{"energy":10}</initvar>门开了。' } })), 'card.json', { maxTextCharacters: 2000000 })
    const { card } = x.assets.importCharacter(parsed)
    const story = x.service.create('取消绑定', { resources: { card: { id: card.id }, lorebooks: [], writingStyles: [] }, scene: { openingSource: 'card' } }, false)
    expect(story.state.namespaces.story?.value).toEqual({ energy: 10 })
    const next = x.service.updateProfile(story.id, story.revision, { ...story.profile, resources: { ...story.profile.resources, card: undefined } })
    expect(next.profile.resources.card).toBeUndefined()
    expect(next.profile.scene).toMatchObject({ openingSource: 'custom', openingText: story.messages[0]!.text })
    expect(next.messages).toEqual(story.messages); expect(next.state).toEqual(story.state)
    expect(x.assets.get(card.id)).toEqual(card)
  })

  it('pauses one story without changing its data or another story, rejects edits during runs, and restores prompt participation', () => {
    const x = setup(), first = x.stories.create('一', profile(), bootstrap()), second = x.stories.create('二', profile(), bootstrap())
    let paused = x.service.updateProfile(first.id, first.revision, { ...first.profile, variables: { enabled: false, mvu: true } })
    expect(paused.state).toEqual(first.state)
    expect(x.contexts.preview(first.id, '', route).parentPrompt).not.toContain('state_commit_contract')
    expect(x.contexts.preview(second.id, '', route).parentPrompt).toContain('state_commit_contract')
    const run = x.service.send(first.id, 'paused', [{ text: '继续', attachmentIds: [] }]).run
    paused = x.stories.snapshot(first.id)
    expect(() => x.service.updateProfile(first.id, paused.revision, { ...paused.profile, variables: { enabled: true, mvu: true } })).toThrow('等待')
    x.stories.setRunStatus(run.id, 'cancelled')
    paused = x.stories.snapshot(first.id)
    const resumed = x.service.updateProfile(first.id, paused.revision, { ...paused.profile, variables: { enabled: true, mvu: true } })
    expect(resumed.state).toEqual(first.state)
    expect(x.contexts.preview(first.id, '', route).parentPrompt).toContain('state_commit_contract')
    expect(x.stories.snapshot(second.id)).toEqual(second)
    for (const variables of [{ enabled: 'false', mvu: true }, { enabled: false }, { enabled: true, mvu: true, extra: true }]) expect(() => normalizeProfile({ ...resumed.profile, variables }, resumed.profile.revision)).toThrow()
  })

  it('keeps MVU import data and initializes only an empty pre-story session; pause/resume never resets existing variables', () => {
    const x = setup(), parsed = parseCharacterCardFile(Buffer.from(JSON.stringify({ spec: 'chara_card_v3', data: { name: '守灯人', first_mes: '<initvar>{"energy":10}</initvar>门开了。' } })), 'card.json', { maxTextCharacters: 2000000 })
    const imported = x.assets.importCharacter(parsed), resources = { card: { id: imported.card.id }, lorebooks: [], writingStyles: [] }
    let story = x.service.create('延后启用', { resources, scene: { openingSource: 'card' }, variables: { enabled: false, mvu: true } }, false)
    expect(story.state.namespaces).toEqual({})
    story = x.service.updateProfile(story.id, story.revision, { ...story.profile, variables: { enabled: true, mvu: true } })
    expect(story.state.namespaces.story?.value).toEqual({ energy: 10 })
    expect(story.messages[0]?.text).toBe('门开了。')
    const initialized = structuredClone(story)
    story = x.service.updateProfile(story.id, story.revision, { ...story.profile, variables: { enabled: false, mvu: true } })
    story = x.service.updateProfile(story.id, story.revision, { ...story.profile, variables: { enabled: true, mvu: false } })
    story = x.service.updateProfile(story.id, story.revision, { ...story.profile, variables: { enabled: true, mvu: true } })
    expect(story.state).toEqual(initialized.state); expect(story.messages).toEqual(initialized.messages)
    const runningStory = x.service.create('已开始', { resources, scene: { openingSource: 'card' }, variables: { enabled: false, mvu: false } }, false)
    x.stories.append(runningStory.id, { type: 'message.added', data: { message: message('user', '继续') } })
    const current = x.stories.snapshot(runningStory.id)
    const enabled = x.service.updateProfile(current.id, current.revision, { ...current.profile, variables: { enabled: true, mvu: true } })
    expect(enabled.state).toEqual(current.state)
    expect(x.assets.get(imported.card.id)).toEqual(imported.card)
  })
})
