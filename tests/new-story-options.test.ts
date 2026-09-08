import { describe, expect, it } from 'vitest'
import { cardOpenings, creationProfile, readNewConversationOptions, selectCharacter, selectedLorebookIds, selectLorebooks, type NewConversationOptions } from '../apps/web/src/pages/new-story-state.ts'

function options(): NewConversationOptions {
  return { title: '', workspaceId: 'workspace-a', includeAssociatedLorebooks: true, profile: {
    revision: 0, playerCharacterId: 'player', cast: [{ characterId: 'player', controller: 'user' }],
    scene: { openingSource: 'card', openingIndex: 3, openingText: '旧的自定义开场' }, runtime: { executionMode: 'chat', writerRoute: { kind: 'inherit' } },
    resources: { card: { id: 'card-a' }, persona: { id: 'persona-a' }, preset: { id: 'preset-a' }, writingStyles: [{ id: 'style-a' }], lorebooks: [{ id: 'manual' }, { id: 'shared' }] },
  } }
}
describe('unsent conversation setup', () => {
  it('omits empty or invalid greetings without shifting indices used by the server', () => {
    expect(cardOpenings({ firstMessage: ' ', alternateGreetings: ['', null, '第三个开场', 3, '最后一个开场'] })).toEqual([{ index: 3, text: '第三个开场' }, { index: 5, text: '最后一个开场' }])
  })
  it('includes associated books once without turning them into permanent manual selections', () => {
    const value = options(), associated = [{ id: 'shared' }, { id: 'associated' }]
    const created = creationProfile(value, associated)
    expect(created.resources.lorebooks).toEqual([{ id: 'manual' }, { id: 'shared' }, { id: 'associated' }])
    expect(value.profile.resources.lorebooks).toEqual([{ id: 'manual' }, { id: 'shared' }])
    expect(creationProfile({ ...value, includeAssociatedLorebooks: false }, associated).resources.lorebooks).toEqual(value.profile.resources.lorebooks)
    expect(creationProfile({ ...value, profile: { ...value.profile, resources: { ...value.profile.resources, card: undefined } } }, associated).resources.lorebooks).toEqual(value.profile.resources.lorebooks)
    expect(created.resources.persona).toEqual(value.profile.resources.persona)
    expect(created.runtime.writerRoute).toEqual({ kind: 'inherit' })
  })
  it('selects linked books as soon as the selected card loads, matching the created conversation', () => {
    const value = selectCharacter({ ...options(), includeAssociatedLorebooks: false }, 'card-b')
    expect(selectedLorebookIds(value, [])).toEqual(['manual', 'shared'])
    const associated = [{ id: 'shared' }, { id: 'linked-b' }]
    expect(selectedLorebookIds(value, associated)).toEqual(['manual', 'shared', 'linked-b'])
    expect(creationProfile(value, associated).resources.lorebooks.map(book => book.id)).toEqual(selectedLorebookIds(value, associated))
    expect(value.profile.scene).toMatchObject({ openingSource: 'card', openingIndex: 0 })
  })
  it('respects individual deselection, including a book selected both manually and by the card', () => {
    const associated = [{ id: 'shared' }, { id: 'linked-a' }, { id: 'linked-b' }]
    const value = selectLorebooks(options(), ['manual', 'linked-b'], associated)
    expect(selectedLorebookIds(value, associated)).toEqual(['manual', 'linked-b'])
    expect(creationProfile(value, associated).resources.lorebooks).toEqual([{ id: 'manual' }, { id: 'linked-b' }])
    const unchecked = selectLorebooks(value, ['manual'], associated)
    expect(selectedLorebookIds(unchecked, associated)).toEqual(['manual'])
    expect(selectedLorebookIds({ ...unchecked, includeAssociatedLorebooks: true }, associated)).toEqual(['manual', 'shared', 'linked-a', 'linked-b'])
  })
  it('keeps edited list order and manual books when switching cards without retaining old automatic books', () => {
    const associated = [{ id: 'shared' }, { id: 'linked-a' }]
    const edited = selectLorebooks(options(), ['linked-a', 'manual', 'extra', 'shared'], associated)
    expect(selectedLorebookIds(edited, associated)).toEqual(['linked-a', 'manual', 'extra', 'shared'])
    expect(creationProfile(edited, associated).resources.lorebooks.map(book => book.id)).toEqual(selectedLorebookIds(edited, associated))
    const changed = selectCharacter(edited, 'card-b')
    expect(selectedLorebookIds(changed, [{ id: 'linked-b' }])).toEqual(['manual', 'extra', 'shared', 'linked-b'])
    expect(selectedLorebookIds(selectCharacter(edited, undefined), associated)).toEqual(['manual', 'extra', 'shared'])
    expect(selectCharacter(edited, undefined).profile.scene.openingSource).toBe('skip')
  })
  it('preserves explicit selections and their ownership when restoring a local draft', () => {
    const associated = [{ id: 'linked-a' }, { id: 'linked-b' }]
    const edited = selectLorebooks(options(), ['linked-b', 'manual', 'shared'], associated)
    const restored = readNewConversationOptions(JSON.stringify(edited), options())
    expect(selectedLorebookIds(restored, associated)).toEqual(['linked-b', 'manual', 'shared'])
    expect(JSON.stringify(creationProfile(restored, associated))).toBe(JSON.stringify(creationProfile(edited, associated)))
    expect(selectedLorebookIds(selectCharacter(restored, 'card-b'), [{ id: 'new-linked' }])).toEqual(['manual', 'shared', 'new-linked'])
    expect(() => readNewConversationOptions(JSON.stringify({ ...edited, autoLorebookIds: [null] }), options())).toThrow()
  })
  it('sends only the selected opening source and preserves an unfinished setup across reloads', () => {
    const value = options()
    expect(creationProfile(value, []).scene).toEqual({ openingSource: 'card', openingIndex: 3 })
    value.profile.scene = { openingSource: 'custom', openingText: '', openingIndex: 3 }
    const restored = readNewConversationOptions(JSON.stringify(value), options())
    expect(restored.profile.scene.openingText).toBe('')
    expect(restored.workspaceId).toBe('workspace-a')
    value.profile.scene.openingText = ' 自己写的开场 '
    expect(creationProfile(value, []).scene).toEqual({ openingSource: 'custom', openingText: '自己写的开场' })
    expect(() => readNewConversationOptions(JSON.stringify({ ...value, profile: { runtime: {} } }), options())).toThrow()
  })
  it('keeps the request fingerprint stable when reloading an uncertain creation request', () => {
    const value = options(), associated = [{ id: 'linked' }]
    const restored = readNewConversationOptions(JSON.stringify(value), options())
    expect(JSON.stringify(creationProfile(restored, associated))).toBe(JSON.stringify(creationProfile(value, associated)))
  })
  it('restores old participation selections without losing an unfinished setup', () => {
    const value = options()
    for (const mode of ['adaptive', 'actor', 'director']) {
      const restored = readNewConversationOptions(JSON.stringify({ ...value, profile: { ...value.profile, mode } }), options())
      expect(restored.profile).not.toHaveProperty('mode')
      expect(restored.profile.cast).toEqual(value.profile.cast)
      expect(restored.profile.resources).toEqual(value.profile.resources)
      expect(restored.profile.scene).toEqual(value.profile.scene)
      expect(restored.workspaceId).toBe(value.workspaceId)
    }
  })
})
