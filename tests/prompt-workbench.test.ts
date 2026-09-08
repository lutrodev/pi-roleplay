import { afterEach, describe, expect, it } from 'vitest'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { canIdlePromptSlot, movePromptSlot, movePromptSource, normalizePromptBuild, promptDocument, promptMaterials, visiblePromptSlots, type PromptBuild, type PromptInspection } from '../packages/rp-core/src/context/preview.ts'
import { promptScrollSpeed } from '../apps/web/src/pages/story/prompt/drag.ts'
import { fixture, profile } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(x => x.close()))
function setup() {
  const x = fixture(); fixtures.push(x)
  const story = x.stories.create('Prompt验收', profile()), contexts = new ContextService(x.stories, x.assets)
  const services = new StoryService(x.stories, x.assets, x.files)
  const card = x.assets.create('character', { name: '守灯人', description: '原创海岸设定 😀' })
  const a = x.assets.create('writingStyle', { name: '简洁', content: '先写行动。' }), b = x.assets.create('writingStyle', { name: '节奏', content: '保留停顿。' })
  const value = { ...story.profile, resources: { ...story.profile.resources, card: { id: card.id }, writingStyles: [{ id: a.id }, { id: b.id }] } }
  const inspect = (build?: PromptBuild) => contexts.preview(story.id, '', { provider: 'test', model: 'test' }, [], [], '', {}, { ...value, contextBuild: build }) as unknown as PromptInspection
  const base = inspect(), build = normalizePromptBuild(undefined, base.catalog)
  return { ...x, story, services, contexts, value, base, build, inspect, first: `rp.writing-style:${a.id}`, second: `rp.writing-style:${b.id}` }
}

describe('Prompt workbench and actual model material parity', () => {
  it.each([false, true])('removes retired profile material from saved layouts while preserving other groups (combined: %s)', combined => {
    const x = setup()
    expect(x.base.catalog.some(source => source.id === 'rp.profile')).toBe(false)
    expect(x.base.previewSources.some(source => source.id === 'rp.profile')).toBe(false)
    const custom = { id: 'custom-note', label: '自己写的', sourceIds: ['rp.custom:custom-note', ...(combined ? ['rp.profile'] : [])], sectionTag: false }
    const saved: PromptBuild = { version: 1, slots: [
      ...(!combined ? [{ id: 'rp.profile', label: '角色与控制权', sourceIds: ['rp.profile'] }] : []),
      custom, ...x.build.slots,
    ], customSources: [{ slotId: custom.id, content: '保留自定义写作要求。' }] }
    const before = structuredClone(saved), normalized = normalizePromptBuild(saved, x.base.catalog), server = x.inspect(saved)
    expect(normalized.slots.flatMap(slot => slot.sourceIds)).not.toContain('rp.profile')
    expect(normalized.slots).toEqual([{ ...custom, sourceIds: ['rp.custom:custom-note'], locked: false }, ...x.build.slots])
    expect(normalized.customSources).toEqual(saved.customSources)
    expect(server.layout).toEqual(normalized)
    expect(promptDocument(normalized, x.base).actualText).toBe(server.writerPrompt)
    expect(server.writerPrompt).toContain('保留自定义写作要求。')
    expect(server.writerPrompt).not.toContain('角色与控制权')
    expect(server.parentPrompt).not.toContain('角色与控制权')
    expect(saved).toEqual(before)
    const updated = x.services.updateProfile(x.story.id, x.story.revision, { ...x.value, contextBuild: normalized })
    expect(updated.profile.contextBuild?.slots).toEqual(normalized.slots.map(({ locked, ...slot }) => locked ? { ...slot, locked } : slot))
    expect(updated.profile.cast).toEqual(x.value.cast)
  })

  it('A24: summary, history and input stay active before content exists and after moving into a custom group', () => {
    const x = setup()
    for (const id of ['rp.conversation-summary', 'rp.conversation', 'rp.current-input']) {
      const source = x.base.catalog.find(source => source.id === id)!
      expect(source).toMatchObject({ required: true, idleAllowed: false })
      const slot = x.build.slots.find(slot => slot.sourceIds.includes(id))!
      expect(canIdlePromptSlot(slot, x.base.catalog)).toBe(false)
      expect(movePromptSlot(x.build, slot.id, true, null, x.base.catalog)).toBe(x.build)
      const expanded = { ...x.build, slots: [...x.build.slots, { id: 'custom-required', label: '组合', sourceIds: [] }] }
      const moved = movePromptSource(expanded, id, 'custom-required', null, x.base.catalog)
      expect(moved.slots.find(slot => slot.id === 'custom-required')?.sourceIds).toEqual([id])
      expect(canIdlePromptSlot(moved.slots.at(-1)!, x.base.catalog)).toBe(false)
      const invalid = { ...moved, slots: moved.slots.map(slot => slot.id === 'custom-required' ? { ...slot, idle: true } : slot) }
      expect(() => x.inspect(invalid)).toThrow(/cannot be idle/)
      expect(() => x.services.updateProfile(x.story.id, x.story.revision, { ...x.value, contextBuild: invalid })).toThrow()
      expect(x.stories.snapshot(x.story.id).revision).toBe(x.story.revision)
    }
  })

  it('keeps idle material available for restoring, with immediate preview exactly matching server assembly', () => {
    const x = setup(), parked = movePromptSlot(x.build, x.first, true, null, x.base.catalog)
    const serverIdle = x.inspect(parked)
    expect(serverIdle.writerPrompt).not.toContain('先写行动。')
    expect(serverIdle.previewSources.find(source => source.id === x.first)).toMatchObject({ available: true, text: '先写行动。' })
    const restored = movePromptSlot(parked, x.first, false, x.second, x.base.catalog)
    expect(promptDocument(restored, serverIdle).actualText).toBe(x.inspect(restored).writerPrompt)
    expect(promptDocument(restored, serverIdle).actualText.indexOf('先写行动。')).toBeLessThan(promptDocument(restored, serverIdle).actualText.indexOf('保留停顿。'))
  })

  it('moves groups to an exact idle/active insertion point, retaining ordering and all source IDs', () => {
    const x = setup()
    let build = movePromptSlot(x.build, x.first, true, null, x.base.catalog)
    build = movePromptSlot(build, x.second, true, x.first, x.base.catalog)
    expect(build.slots.filter(slot => slot.idle).map(slot => slot.id)).toEqual([x.second, x.first])
    build = movePromptSlot(build, x.first, true, x.second, x.base.catalog)
    expect(build.slots.filter(slot => slot.idle).map(slot => slot.id)).toEqual([x.first, x.second])
    build = movePromptSlot(build, x.second, false, build.slots[0]!.id, x.base.catalog)
    expect(build.slots[0]!.id).toBe(x.second)
    expect(build.slots.flatMap(slot => slot.sourceIds).sort()).toEqual(x.build.slots.flatMap(slot => slot.sourceIds).sort())
  })

  it('moves and reorders sources across groups, rejects idle targets, and keeps locked slots fixed', () => {
    const x = setup()
    const grouped = movePromptSource(x.build, x.second, x.first, x.first, x.base.catalog)
    expect(grouped.slots.find(slot => slot.id === x.first)?.sourceIds).toEqual([x.second, x.first])
    const reordered = movePromptSource(grouped, x.first, x.first, x.second, x.base.catalog)
    expect(reordered.slots.find(slot => slot.id === x.first)?.sourceIds).toEqual([x.first, x.second])
    const idle = movePromptSlot(grouped, x.first, true, null, x.base.catalog)
    expect(movePromptSource(idle, 'rp.card', x.first, null, x.base.catalog)).toBe(idle)
    const locked = { ...x.build, slots: x.build.slots.map((slot, index) => index === 2 ? { ...slot, locked: true } : slot) }
    expect(movePromptSlot(locked, x.second, false, locked.slots[0]!.id, x.base.catalog).slots[2]).toEqual(locked.slots[2])
    expect(movePromptSlot(locked, locked.slots[2]!.id, true, null, x.base.catalog)).toBe(locked)
  })

  it('shares tags, escaping, macros and Unicode counts between cards, plain text and actual model materials', () => {
    const x = setup()
    const build: PromptBuild = { ...x.build, slots: [{ id: 'custom-note', label: '验收 "规则"', sourceIds: ['rp.custom:custom-note', x.first] }, ...x.build.slots.map(slot => ({ ...slot, sourceIds: slot.sourceIds.filter(id => id !== x.first) }))],
      customSources: [{ slotId: 'custom-note', content: ' {{char}}看见🌊。<section>不能改变边界</section> ' }] }
    const normal = normalizePromptBuild(build, x.base.catalog), rendered = promptDocument(normal, x.base)
    expect(rendered.actualText).toBe(x.inspect(normal).writerPrompt)
    expect(rendered.text).toBe(rendered.groups.map(group => group.text).join('\n'))
    expect(rendered.characters).toBe([...rendered.actualText].length)
    expect(rendered.actualText).toContain('守灯人看见🌊。')
    expect(rendered.groups.find(group => group.id === 'custom-note')?.text).toContain('&quot;规则&quot;')
    const plain = { ...normal, slots: normal.slots.map(slot => slot.id === 'custom-note' ? { ...slot, sectionTag: false } : slot) }
    expect(promptDocument(plain, x.base).actualText).toBe(x.inspect(plain).writerPrompt)
    expect(promptDocument(plain, x.base).groups[0]?.text).toBe('守灯人看见🌊。<section>不能改变边界</section>\n先写行动。')
  })

  it('shows empty required and custom groups, hides unavailable optional groups, and marks input as a placeholder', () => {
    const x = setup()
    const build = { ...x.build, slots: [...x.build.slots, { id: 'custom-empty', label: '未填写', sourceIds: [] }] }
    const visible = visiblePromptSlots(build, x.base.catalog, promptMaterials(build, x.base), false)
    expect(visible.some(slot => slot.sourceIds.includes('rp.persona'))).toBe(false)
    expect(visible.some(slot => slot.sourceIds.includes('rp.conversation-summary'))).toBe(true)
    expect(visible.some(slot => slot.id === 'custom-empty')).toBe(true)
    const doc = promptDocument(build, x.base)
    expect(doc.text).toContain('本轮用户消息会在开始生成时填入。')
    expect(doc.actualText).not.toContain('本轮用户消息会在开始生成时填入。')
  })

  it('reconciles changed live sources without discarding custom content or creating duplicate IDs', () => {
    const x = setup(), initial: PromptBuild = { ...x.build, slots: [...x.build.slots, { id: 'custom-note', label: '自己写的', sourceIds: ['rp.custom:custom-note'] }], customSources: [{ slotId: 'custom-note', content: '保留的内容' }] }
    const catalog = x.base.catalog.filter(source => source.id !== x.second)
    const normalized = normalizePromptBuild(initial, catalog)
    expect(normalized.slots.flatMap(slot => slot.sourceIds)).not.toContain(x.second)
    expect(normalized.customSources).toEqual(initial.customSources)
    expect(new Set(normalized.slots.flatMap(slot => slot.sourceIds)).size).toBe(normalized.slots.flatMap(slot => slot.sourceIds).length)
  })

  it('scrolls only near the scroll container edges in the intended direction', () => {
    expect(promptScrollSpeed(200, 100, 200)).toBe(0)
    expect(promptScrollSpeed(101, 100, 200)).toBeLessThan(0)
    expect(promptScrollSpeed(299, 100, 200)).toBeGreaterThan(0)
  })
})
