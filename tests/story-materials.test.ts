import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { StoryWiki } from '../apps/web/src/pages/story/wiki.tsx'
import { MaterialReader } from '../apps/web/src/pages/story/material-reader.tsx'
import { SummaryPanel } from '../apps/web/src/pages/story/summary-panel.tsx'
import { materialEntries, materialExcerpt, materialMatches, materialReferences, materialSections } from '../apps/web/src/pages/story/material-content.ts'
import { ApiError } from '../apps/web/src/lib/api.ts'
import { projectStory } from '../packages/rp-core/src/story/projection.ts'
import { recapPage, readingView, type RecapPage } from '../packages/protocol/src/reading.ts'
import type { AssetKind, AssetRecord, JsonObject } from '../packages/rp-core/src/types.ts'
import { profile } from './helpers.ts'

const asset = (id: string, kind: AssetKind, data: JsonObject = {}): AssetRecord => ({ id, kind, name: id, data, revision: 1, createdAt: '', updatedAt: '', avatarFileId: null, sourceHash: null, sourceCharacterId: null })
const story = () => projectStory([{ seq: 1, storyId: 'story', createdAt: '', type: 'story.created', data: { title: '灯塔来信', profile: profile(), bootstrap: { namespaces: {} } } }])
function render(element: ReactElement, assets: AssetRecord[] = [], recap?: RecapPage) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const item of assets) client.setQueryData(['asset', item.id], { asset: item, associatedLorebooks: [asset('未绑定的关联世界书', 'lorebook')] })
  if (recap) client.setQueryData(['story-recap', 'story'], { pages: [recap], pageParams: [null] })
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() })
  const html = renderToStaticMarkup(createElement(RouterContextProvider<typeof router>, { router, children: createElement(QueryClientProvider, { client }, element) }))
  client.clear()
  return html
}
const read = (item: AssetRecord, query = '') => render(createElement(MaterialReader, { asset: item, kind: item.kind, pending: false, error: null, retry() {}, query, back() {}, storyId: 'story' }))

describe('conversation material reader', () => {
  it('groups only explicitly bound resources, preserving multi-book order and deduplicating references', () => {
    const config = profile()
    config.resources = { card: { id: 'card' }, persona: { id: 'persona' }, preset: { id: 'preset' }, lorebooks: [{ id: 'second' }, { id: 'first' }, { id: 'second' }], writingStyles: [{ id: 'style' }] }
    expect(materialReferences(config)).toEqual([{ id: 'card', kind: 'character' }, { id: 'persona', kind: 'persona' }, { id: 'second', kind: 'lorebook' }, { id: 'first', kind: 'lorebook' }, { id: 'preset', kind: 'preset' }, { id: 'style', kind: 'writingStyle' }])
    expect(config.resources.lorebooks).toHaveLength(3)
  })

  it('searches every lore category, disabled entries and secondary keys without searching duplicated import payloads', () => {
    const book = asset('雾港', 'lorebook', { entries: [
      { id: 'a', name: '旧灯塔', content: '海岸', level: 'worldDescription', keys: ['邮戳'] },
      { id: 'b', name: '表演', content: '语气克制', level: 'roleplayGuide', secondaryKeys: ['蓝信'] },
      { id: 'c', name: '秘密', content: '失踪的渡船', level: 'importantRules', enabled: false },
    ], sourcePayload: { privateNote: '只留在导入原文' } })
    for (const word of ['邮戳', '蓝信', '失踪的渡船', '雾港']) expect(materialMatches(book, word)).toBe(true)
    expect(materialMatches(book, '只留在导入原文')).toBe(false)
    expect(materialExcerpt(book, '失踪的渡船')).toContain('失踪的渡船')
    const html = read(book, '失踪的渡船')
    expect(html).toContain('重要规则')
    expect(html).toContain('已停用')
    expect(html).toContain('<mark>失踪的渡船</mark>')
    expect(html).not.toContain('旧灯塔')
  })

  it('exposes accepted extra prompts while excluding quarantined instructions and editor payloads', () => {
    const card = asset('守塔人', 'character', { description: '介绍', firstMessage: '开场', alternateGreetings: ['另一种开场'], quarantinedPrompts: [{ path: 'system_prompt', value: '未接受的提示' }, { path: 'accepted', value: '已接受的提示' }], acceptedPromptPaths: ['accepted'], extensions: { secret: 'editor data' } })
    expect(materialSections(card).map(section => section.text)).toEqual(['介绍', '开场', '另一种开场', '已接受的提示'])
    expect(materialEntries(card)).toEqual([])
  })

  it('shows a compact grouped overview without resource mutation controls or unbound associated books', () => {
    const snapshot = story()
    snapshot.profile.resources = { card: { id: '守塔人' }, persona: { id: '来访者' }, lorebooks: [{ id: '雾港' }], writingStyles: [] }
    const card = asset('守塔人', 'character', { description: '简短介绍', firstMessage: '不应在总览展开的完整开场' })
    const html = render(createElement(StoryWiki, { story: snapshot }), [card, asset('来访者', 'persona'), asset('雾港', 'lorebook')])
    for (const text of ['人物 · 2', '世界 · 1', '写作 · 0', '守塔人', '来访者']) expect(html).toContain(text)
    for (const text of ['雾港', '未绑定的关联世界书', '不应在总览展开的完整开场', '<form', '<select', '编辑角色卡', '创建并用于本会话', '>更换<', '>新建<']) expect(html).not.toContain(text)
  })

  it('keeps large text folded until read or found by search, preserving full content and escaping markup', () => {
    const card = asset('长资料', 'character', { description: '灯塔'.repeat(1000) + '\n独有线索 **海图** <script>untrusted()</script>' })
    expect(read(card)).not.toContain('独有线索')
    const searched = read(card, '独有线索')
    expect(searched).toContain('<mark>独有线索</mark>')
    expect(searched).toContain('<strong>海图</strong>')
    expect(searched).not.toContain('<script>')
    expect(String(card.data.description)).toContain('<script>')
  })

  it('keeps retry and back available when a bound asset was removed', () => {
    const html = render(createElement(MaterialReader, { kind: 'character', pending: false, error: new ApiError('这份资料已不存在。', 'NOT_FOUND', 404), retry() {}, query: '', back() {}, storyId: 'story' }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('这份资料已不存在。')
    expect(html).toContain('资料总览')
    expect(html).toContain('重试')
    expect(html).not.toContain('暂无文字介绍')
  })

  it('separates accumulated context summary from newer committed plot summaries without duplicate coverage', () => {
    const snapshot = story()
    snapshot.checkpoint = { text: '前情：已抵达灯塔。', throughMessageId: 'old', sourceMessageIds: ['old'] }
    snapshot.summaries = [{ messageId: 'old', text: '已经被概括的旧记录' }, { messageId: 'new', text: '发现了蓝色邮戳。' }, { messageId: 'newest', text: '两封信终于并排放在桌上。' }]
    const html = render(createElement(SummaryPanel, { story: readingView(snapshot).story }), [], recapPage(snapshot))
    expect(html).toContain('前情：已抵达灯塔。')
    expect(html).not.toContain('已经被概括的旧记录')
    expect(html.indexOf('两封信终于并排')).toBeLessThan(html.indexOf('发现了蓝色邮戳'))
    expect(html).not.toContain('type="submit"')
  })

  it('shows an honest empty summary state before any story content exists', () => {
    const html = render(createElement(SummaryPanel, { story: story() }), [], recapPage(story()))
    expect(html).toContain('故事回顾会出现在这里')
    expect(html).not.toContain('前情摘要')
  })

  it('pages through actual recaps without adding them to the live snapshot or reintroducing summarized history', () => {
    const snapshot = story()
    snapshot.summaries = Array.from({length: 13}, (_, index) => ({messageId: `message-${index}`, text: `进展 ${index}`}))
    snapshot.checkpoint = {text:'旧剧情',throughMessageId:'message-1',sourceMessageIds:['message-0','message-1']}
    const first = recapPage(snapshot), second = recapPage(snapshot, first.before!), third = recapPage(snapshot, second.before!)
    expect(first.items.map(item => item.messageId)).toEqual(['message-12','message-11','message-10','message-9','message-8'])
    expect(second.items.map(item => item.messageId)).toEqual(['message-7','message-6','message-5','message-4','message-3'])
    expect(third.items.map(item => item.messageId)).toEqual(['message-2'])
    expect(third.before).toBeNull()
    expect(first.total).toBe(11)
    expect(readingView(snapshot).story.summaries).toEqual([])
    expect(() => recapPage(snapshot, 'removed-message')).toThrow('剧情回顾已更新')
  })
})
