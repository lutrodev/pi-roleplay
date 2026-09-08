import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { StoryRepository } from '../apps/server/src/storage/story-repository.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { RpError } from '../packages/rp-core/src/errors.ts'
import { normalizeLoreBook, activateLore } from '../packages/rp-core/src/lore/activation.js'
import { moveEntry, matchesEntry } from '../packages/rp-core/src/lore/editing.ts'
import { stateFields } from '../packages/rp-core/src/display/state-fields.ts'
import { messagePage, readingView, storyNotice } from '../packages/protocol/src/reading.ts'
import type { JsonObject, StoryEvent } from '../packages/rp-core/src/types.ts'
import { fixture, profile, message, recordModelReply } from './helpers.ts'

const cleanup: ReturnType<typeof fixture>[] = []
afterEach(() => cleanup.splice(0).forEach(item => item.close()))
function setup() { const x = fixture(); cleanup.push(x); return { ...x, service: new StoryService(x.stories, x.assets, x.files), turns: new TurnService(x.stories) } }
const route = { provider: 'test', model: 'test' }
const definition = { title: '旅途', updateMode: 'schema-only', schema: { type: 'object', properties: { coins: { type: 'number' } }, additionalProperties: false }, rules: [] }

describe('completeness audit regressions', () => {
  it.each(['discussion', 'narrative'] as const)('A01: deletes earlier hidden variable owners with the visible %s reply, including forks and restart', async finish => {
    const x = setup(), config = profile(); config.runtime.executionMode = 'agent'
    const initial = x.stories.create('归属', config), run = x.service.send(initial.id, 'first', [{ text: '建立变量', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running')
    const owner = message('assistant', '', { kind: 'tool', runId: run.id, turnId: run.turnId })
    x.stories.append(initial.id, { type: 'message.added', data: { message: owner } })
    x.turns.configureState(run.id, owner.id, { operation: 'create', namespace: 'story', expectedRevision: 0, definition, initialValue: { coins: 3 } })
    const final = message('assistant', '完整回复', { runId: run.id, turnId: run.turnId })
    recordModelReply(x.stories, run, final.id, final.text)
    if (finish === 'narrative') {
      const context = new ContextService(x.stories, x.assets).freeze(run.id, route)
      x.turns.recordWriter(run.id, 'writer', context.seq, '完整回复'); await x.turns.commit(run.id, final.id, final.text, {})
    } else x.stories.append(initial.id, { type: 'message.added', data: { message: final } })
    x.stories.setRunStatus(run.id, 'completed')
    const story = x.stories.snapshot(initial.id), branch = x.service.fork(story.id, story.revision, final.id)
    expect(branch.state.namespaces.story?.value).toEqual({ coins: 3 })
    for (const target of [story, branch]) {
      const visible = target.messages.filter(item => item.kind !== 'tool').at(-1)!
      const removed = x.service.remove(target.id, target.revision, visible.id)
      expect(removed.messages.map(item => item.role)).toEqual(['user'])
      expect(removed.state.namespaces).toEqual({})
    }
    x.database.close(); const reopened = new AppDatabase(x.filename)
    try { expect(new StoryRepository(reopened).snapshot(story.id).state.namespaces).toEqual({}) } finally { reopened.close() }
  })

  it('A03: defaults bind selected personas, respect explicit empty bindings and repair deletion', () => {
    const x = setup(), seeded = x.assets.ensureDefaults(), custom = x.assets.create('persona', { name: '旅人' })
    x.assets.setDefault('persona', custom.id)
    const first = x.service.create('采用默认')
    expect(first.profile.resources.persona?.id).toBe(custom.id)
    expect(first.profile.cast[0]?.name).toBe('旅人')
    expect(x.service.create('不绑定', {}, false).profile.resources).toEqual({ lorebooks: [], writingStyles: [] })
    x.assets.remove(custom.id, custom.revision)
    expect(x.assets.ensureDefaults().persona).toBe(seeded.persona)
    x.assets.remove(seeded.persona, 1)
    const restored = x.assets.ensureDefaults(); expect(x.assets.get(restored.persona).name).toBe('用户角色')
  })

  it.each(['character', 'lorebook'] as const)('A05: %s catalogs preserve newest-created order after edits', kind => {
    const x = setup(), first = x.assets.create(kind, { name: 'A 旧资料', ...(kind === 'lorebook' ? { entries: [] } : {}) }), second = x.assets.create(kind, { name: 'Z 新资料', ...(kind === 'lorebook' ? { entries: [] } : {}) })
    expect(x.assets.catalog(kind).assets.map(item => item.id)).toEqual([second.id, first.id])
    x.assets.update(first.id, first.revision, { ...first.data, name: 'ZZ 已编辑' })
    expect(x.assets.catalog(kind).assets.map(item => item.id)).toEqual([second.id, first.id])
  })

  it('A06: deleted opening cards do not block unrelated profile edits or erase opening edits', () => {
    const x = setup(), card = x.assets.create('character', { name: '守塔人', firstMessage: '原开场' })
    let story = x.service.create('开场', { scene: { openingSource: 'card', openingIndex: 0 }, resources: { card: { id: card.id }, lorebooks: [], writingStyles: [] } })
    story = x.service.edit(story.id, story.revision, story.messages[0]!.id, '已手工修改的开场')
    x.assets.remove(card.id, card.revision)
    story = x.service.updateProfile(story.id, story.revision, { ...story.profile, runtime: { executionMode: 'agent' } })
    expect(story.messages[0]?.text).toBe('已手工修改的开场')
    expect(story.profile.runtime.executionMode).toBe('agent')
    expect(() => x.service.updateProfile(story.id, story.revision, { ...story.profile, scene: { openingSource: 'card', openingIndex: 1 } })).toThrow()
  })

  it('A07: archive rejects regeneration and enqueues no run', () => {
    const x = setup(), story = x.service.create('归档'), run = x.service.send(story.id, 'first', [{ text: '继续', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'cancelled')
    x.service.archive(story.id, x.stories.snapshot(story.id).revision, true)
    const archived = x.stories.snapshot(story.id)
    expect(() => x.service.regenerate(story.id, archived.revision, archived.messages.at(-1)!.id, 'again')).toThrow('恢复')
    expect(x.stories.storyRuns(story.id)).toHaveLength(1)
  })

  it('A04/A09: visible movement changes actual lore activation and filters search all relevant text', () => {
    const book = normalizeLoreBook({ id: 'book', name: '排序', entries: [{ id: 'a', name: '甲', content: '甲内容', constant: true, order: 10 }, { id: 'b', name: '乙', content: '乙内容', constant: true, order: 20 }] })
    const entries = moveEntry(book.entries as JsonObject[], 0, 1)
    const saved = normalizeLoreBook({ ...book, entries })
    expect(activateLore({ books: [saved], corpus: '', runId: 'run', maxDepth: 3, maxEntries: 20, maxTokens: 10000 }).entries.map(item => item.id)).toEqual(['b', 'a'])
    expect(matchesEntry({ content: '灯塔正文', keys: ['北海'], secondaryKeys: ['船'], enabled: false, level: 'importantRules' }, '北海', 'disabled', 'importantRules')).toBe(true)
    expect(matchesEntry({ content: '灯塔正文', enabled: false }, '灯塔', 'enabled', '')).toBe(false)
  })

  it('A12: variable fields follow schema order and retain titles, descriptions, unchanged values and escaped paths', () => {
    expect(stateFields({ 'a/b': '很长的文字'.repeat(100), energy: 3 }, { type: 'object', properties: { energy: { type: 'number', title: '精力', description: '继续行动所需的精力' }, 'a/b': { type: 'string', title: '经历' } } })).toEqual([
      { path: '/energy', title: '精力', description: '继续行动所需的精力', value: 3 }, { path: '/a~1b', title: '经历', value: '很长的文字'.repeat(100) },
    ])
  })

  it('A16: collects independent references, effects, extensions and guard failures with pointers, committing nothing', async () => {
    const x = setup(), story = x.service.create('诊断'), run = x.service.send(story.id, 'first', [{ text: '继续', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running')
    const context = new ContextService(x.stories, x.assets).freeze(run.id, route)
    x.turns.recordWriter(run.id, 'writer', context.seq, '完整正文')
    let failure: RpError | undefined
    try { await x.turns.commit(run.id, randomUUID(), '', { references: [{ source: 'a', id: 'a', revision: 1 }, { source: 'b', id: 'b', revision: 1 }], extensions: { unsupported: {} }, effects: [{ kind: 'state.update', namespace: 'missing', expectedRevision: 1, payload: { changes: [{ op: 'set', path: '/coins', value: 5, reason: '测试' }] } }] }, true, () => { throw new RpError('GUARD_CHANGED', '资料已变更', 409) }) } catch (error) { failure = error as RpError }
    const details = failure?.details as { issues: { path: string }[]; retry: { token: string } }
    expect(details.issues.map(item => item.path)).toEqual(expect.arrayContaining(['/references/0/source', '/references/1/source', '/effects/0/namespace', '/extensions', '/guard']))
    expect(details.retry.token).toBeTruthy(); expect(x.stories.hasCommitted(run.id)).toBe(false)
    expect(x.stories.snapshot(story.id).state.namespaces).toEqual({})
    await x.turns.commit(run.id, randomUUID(), '', { retry: { token: details.retry.token, patches: [
      { op: 'replace', path: '/references', value: [] }, { op: 'replace', path: '/effects', value: [] }, { op: 'replace', path: '/extensions', value: {} },
    ] } })
    expect(x.stories.hasCommitted(run.id)).toBe(true)
    expect(x.stories.snapshot(story.id).messages.at(-1)?.text).toBe('完整正文')
  })

  it('A17: 600-message reading windows and notification payloads are bounded without dropping earlier messages', () => {
    const x = setup(), initial = x.service.create('长故事')
    x.database.transaction(() => { for (let index = 0; index < 600; index++) x.stories.append(initial.id, { type: 'message.added', data: { message: message(index % 2 ? 'assistant' : 'user', '合成正文'.repeat(500)) } }) })
    const snapshot = x.stories.snapshot(initial.id), view = readingView(snapshot)
    expect(view.story.messages).toHaveLength(30); expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(220000)
    let page = messagePage(snapshot), read = page.messages
    while (page.before) { page = messagePage(snapshot, page.before); read = [...page.messages, ...read] }
    expect(read.map(item => item.id)).toEqual(snapshot.messages.map(item => item.id))
    const event = x.stories.append(initial.id, { type: 'context.built', data: { runId: 'run', writerPrompt: '大上下文'.repeat(50000), parentPrompt: '资料', sources: [], model: route } })
    expect(JSON.stringify(storyNotice(event)).length).toBeLessThan(200)
    expect(storyNotice({ ...event, type: 'run.draft', data: { runId: 'run', text: '实时草稿', replace: true } } as StoryEvent).data.text).toBe('实时草稿')
  })

  it('A19: limits styles and UTF-8 profile bytes while accepting Unicode character counts', () => {
    const x = setup(), styles = Array.from({ length: 17 }, () => ({ id: randomUUID() }))
    expect(() => x.service.create('过多文风', { resources: { lorebooks: [], writingStyles: styles } })).toThrow()
    expect(() => x.service.create('过大配置', { scene: { openingSource: 'custom', openingText: '字'.repeat(90000) } })).toThrow('256 KB')
    expect(x.service.create('🌊'.repeat(120)).title).toBe('🌊'.repeat(120))
    expect(() => x.service.create('🌊'.repeat(121))).toThrow('120')
  })
})
