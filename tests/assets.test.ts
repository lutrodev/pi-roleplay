import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { AssetRepository } from '../apps/server/src/storage/asset-repository.ts'
import { parseCharacterCardFile } from '../packages/rp-core/src/character/character-card.js'
import { DEFAULT_PRESET } from '../packages/rp-core/src/seeds/preset.js'
import { DEFAULT_WRITING_STYLE } from '../packages/rp-core/src/seeds/writing-style.js'
import { fixture, profile } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => { for (const item of fixtures.splice(0)) item.close() })
function setup() { const item = fixture(); fixtures.push(item); return item }
function importedCard(name = '守塔人') {
  return parseCharacterCardFile(Buffer.from(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
    name, description: '守候海岸', first_mes: '欢迎来到灯塔。', system_prompt: 'Untrusted instructions',
    character_book: { entries: [{ keys: ['灯塔'], content: '灯塔每晚亮起。' }] },
  } })), 'card.json', { maxTextCharacters: 2_000_000 })
}

describe('shared assets and first-use defaults', () => {
  it('initializes persona, preset and style, without duplicating or overwriting edits on restart', () => {
    const { database, assets, filename } = setup()
    const defaults = assets.ensureDefaults()
    expect(assets.list('character')).toEqual([])
    expect(assets.list('lorebook')).toEqual([])
    expect(assets.list('persona')).toHaveLength(1)
    expect(assets.get(defaults.persona).name).toBe('用户角色')
    expect(assets.get(defaults.preset).data.fields).toEqual(DEFAULT_PRESET.fields.map(field => expect.objectContaining(field)))
    expect(assets.get(defaults.writingStyle).data).toEqual(DEFAULT_WRITING_STYLE)
    const edited = assets.update(defaults.writingStyle, 1, { name: '我的文风', description: '', content: '保持我的修改。' })
    expect(assets.ensureDefaults()).toEqual(defaults)
    database.close()
    const reopened = new AppDatabase(filename)
    try {
      const restored = new AssetRepository(reopened)
      expect(restored.ensureDefaults()).toEqual(defaults)
      expect(restored.get(defaults.writingStyle)).toEqual(edited)
      expect(restored.list('preset')).toHaveLength(1)
    } finally { reopened.close() }
  })

  it('repairs a removed default using an existing asset before creating another seed', () => {
    const { assets } = setup()
    const initial = assets.ensureDefaults()
    const other = assets.create('writingStyle', { name: '保留项', content: '另一个文风' })
    assets.remove(initial.writingStyle, 1)
    expect(assets.ensureDefaults().writingStyle).toBe(other.id)
    expect(assets.list('writingStyle')).toHaveLength(1)
    assets.remove(other.id, 1)
    const repaired = assets.ensureDefaults()
    expect(repaired.writingStyle).not.toBe(initial.writingStyle)
    expect(assets.get(repaired.writingStyle).data).toEqual(DEFAULT_WRITING_STYLE)
  })

  it('rejects stale writes and invalid complete text limits', () => {
    const { assets } = setup()
    const persona = assets.create('persona', { name: '旅人', description: '听潮的人' })
    assets.update(persona.id, 1, { name: '旅人', description: '已经更新' })
    expect(() => assets.update(persona.id, 1, { name: '旧修改' })).toThrow('已经更新')
    expect(() => assets.remove(persona.id, 1)).toThrow('已经更新')
    expect(() => assets.create('writingStyle', { name: '长文', content: '字'.repeat(30_000) })).toThrow('长度')
    const exact = assets.create('writingStyle', { name: '文', content: '字'.repeat(29_999) })
    expect(String(exact.data.content)).toHaveLength(29_999)
  })

  it('imports a card and its embedded book atomically, quarantines prompts, and detects duplicates', () => {
    const { assets } = setup()
    const parsed = importedCard()
    const result = assets.importCharacter(parsed)
    expect(result.card.name).toBe('守塔人')
    expect(result.card.data.acceptedPromptPaths).toEqual([])
    expect(result.card.data.quarantinedPrompts).toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining('system_prompt') })]))
    expect(result.lorebook?.sourceCharacterId).toBe(result.card.id)
    expect(assets.associatedLorebooks(result.card.id)).toHaveLength(1)
    expect(() => assets.importCharacter(parsed)).toThrow('已经导入')
    expect(assets.list('character')).toHaveLength(1)
    expect(assets.list('lorebook')).toHaveLength(1)
  })

  it('keeps story references and allows missing cards after deletion, optionally retaining books', () => {
    const { assets, stories } = setup()
    const { card, lorebook } = assets.importCharacter(importedCard())
    const config = profile()
    config.resources.card = { id: card.id }
    const story = stories.create('已开始的故事', config)
    assets.removeCharacter(card.id, 1, false)
    expect(stories.snapshot(story.id).profile.resources.card?.id).toBe(card.id)
    expect(assets.resolve(card.id, 'character')).toBeNull()
    expect(assets.get(lorebook!.id).id).toBe(lorebook!.id)
  })

  it('removes associated books by default without altering unrelated assets', () => {
    const { assets } = setup()
    const { card } = assets.importCharacter(importedCard())
    const unrelated = assets.create('lorebook', { name: '其他世界书', entries: [] })
    expect(assets.removeCharacter(card.id, 1)).toEqual({ removedId: card.id, associatedFailures: [] })
    expect(assets.associatedLorebooks(card.id)).toEqual([])
    expect(assets.get(unrelated.id).name).toBe('其他世界书')
  })
})

it('counts a large imported card once while preserving its original source, edits and the actual text limit', () => {
  const x = setup(), description = '字'.repeat(1_050_000)
  const parsed = parseCharacterCardFile(Buffer.from(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: '大卡回归', description } })), 'large.json', { maxTextCharacters: 2_000_000 })
  const { card } = x.assets.importCharacter(parsed)
  expect(card.data.description).toBe(description)
  expect(card.data.sourcePayload).toEqual(parsed.sourcePayload)
  expect(x.assets.update(card.id, card.revision, { name: '大卡已编辑', description }).data.description).toBe(description)
  expect(() => x.assets.update(card.id, 2, { name: '超限', description: '字'.repeat(2_000_001) })).toThrow('长度')
})
