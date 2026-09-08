import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { variableSections } from '../apps/web/src/pages/story/variables-model.ts'
import { VariablesPanel, VariableValues } from '../apps/web/src/pages/story/variables.tsx'
import { VariablesCard, VariablesToggle } from '../apps/web/src/pages/story/variables-card.tsx'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import type { StorySnapshot, StoryState } from '../packages/rp-core/src/types.ts'
import { message, profile } from './helpers.ts'

function state(value: Record<string, unknown>): StoryState {
  return { namespaces: { story: createNamespaceSnapshot({ definition: { title: '灯塔', updateMode: 'schema-only', rules: [], schema: { type: 'object', properties: { energy: { type: 'number', title: '精力' }, weather: { type: 'string', title: '天气' }, companion: { type: 'object', title: '同行者', properties: { name: { type: 'string', title: '姓名' }, ready: { type: 'boolean', title: '准备好了' } } } } } }, initialValue: value }) } }
}
const rows = (value: ReturnType<typeof variableSections>) => value.flatMap(section => section.groups.flatMap(group => group.rows))

describe('complete variables with optional reply annotations', () => {
  it('retains unchanged values alongside changed and newly added values', () => {
    const before = state({ energy: 10, weather: '晴', companion: { name: '青禾', ready: false } })
    const after = state({ energy: 9, weather: '晴', companion: { name: '青禾', ready: true }, clue: '旧信' })
    const result = variableSections(after, { before, after })
    expect(rows(result)).toMatchObject([
      { path: '/energy', label: '精力', value: 9, change: { before: 10, kind: 'updated' } },
      { path: '/weather', label: '天气', value: '晴' },
      { path: '/clue', value: '旧信', change: { kind: 'added' } },
      { path: '/companion/name', label: '姓名', value: '青禾' },
      { path: '/companion/ready', label: '准备好了', value: true, change: { before: false } },
    ])
    expect(result[0]!.groups.find(group => group.path === '/companion')?.title).toBe('同行者')
    expect(rows(result).find(field => field.path === '/weather')?.change).toBeUndefined()
  })
  it('shows the full snapshot when a reply changes nothing or annotations are disabled', () => {
    const current = state({ energy: 9, weather: '晴' })
    expect(rows(variableSections(current, { before: current, after: current }))).toHaveLength(2)
    expect(rows(variableSections(current)).every(field => !field.change)).toBe(true)
  })
  it('keeps current values authoritative when the fetched reply boundary is older', () => {
    const before = state({ energy: 10, weather: '晴' }), after = state({ energy: 9, weather: '晴' }), current = state({ energy: 8, weather: '雨' })
    expect(rows(variableSections(current, { before, after }))).toMatchObject([{ value: 8 }, { value: '雨' }])
    expect(rows(variableSections(current, { before, after })).every(field => !field.change)).toBe(true)
    expect(rows(variableSections(after, { before, after }))[0]).toMatchObject({ value: 9, change: { before: 10 } })
  })
  it('retains removed fields and namespaces as annotations, with escaped paths and long values intact', () => {
    const before = state({ energy: 9, '线索/来源': '海边'.repeat(200), nested: { lost: '钥匙' } }), after = state({ energy: 9 })
    expect(rows(variableSections(after, { before, after }))).toMatchObject([
      { path: '/energy', value: 9 },
      { path: '/线索~1来源', label: '线索/来源', value: undefined, change: { kind: 'removed', before: '海边'.repeat(200) } },
      { path: '/nested/lost', value: undefined, change: { before: '钥匙' } },
    ])
    const empty = { namespaces: {} }
    expect(variableSections(empty, { before, after: empty })[0]?.removed).toBe(true)
    expect(rows(variableSections(empty, { before, after: empty }))).toHaveLength(3)
    expect(variableSections(empty)).toEqual([])
  })
  it('preserves arrays, empty objects, null and literal text without treating them as missing values', () => {
    const current = state({ notes: ['<script>literal</script>', ''], empty: {}, missing: null, companion: { name: '青禾', ready: false } })
    const html = renderToStaticMarkup(createElement(VariableValues, { state: current }))
    expect(rows(variableSections(current))).toHaveLength(6)
    expect(html).toContain('&lt;script&gt;literal&lt;/script&gt;')
    expect(html).toContain('空文本')
    expect(html).toContain('<span>否</span>')
    expect(html).toContain('<span>空</span>')
    expect(html).toContain('<span>{}</span>')
  })
  it('keeps the full inspector on live values with the latest reply only supplying annotations', () => {
    const earlier = message('assistant', '第一轮回复', { id: 'earlier', kind: 'narrative' })
    const latest = message('assistant', '第二轮回复', { id: 'latest', kind: 'narrative' })
    const current = state({ energy: 8, weather: '晴' }), previous = state({ energy: 9, weather: '晴' })
    const story: StorySnapshot = { id: 'story', title: '灯塔', revision: 5, archived: false, profile: profile(), messages: [earlier, latest], conversationRunId: null, state: current, summaries: [], tools: [], questions: [], replyOptions: {}, maintenance: {}, summaryCandidate: null, checkpoint: null, createdAt: '', updatedAt: '' }
    const client = new QueryClient()
    client.setQueryData(['reply-state', story.id, latest.id], { before: previous, after: current })
    client.setQueryData(['reply-state', story.id, earlier.id], { before: state({ energy: 10 }), after: previous })
    const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() })
    const html = renderToStaticMarkup(createElement(RouterContextProvider<typeof router>, { router, children: createElement(QueryClientProvider, { client }, createElement(VariablesPanel, { story, latestReplyId: latest.id })) }))
    expect(html).toContain('标记最近一轮变化')
    expect(html).toContain('变量定义与维护规则')
    expect(html).toContain('class="variable-current-value"><span>8</span>')
    expect(html).toContain('class="variable-current-value"><span>晴</span>')
    expect(html).not.toContain('variables-history-note')
    client.clear()
  })
  it('keeps the footer toggle separate from collapsed content and reports counts when expanded', () => {
    const before = state({ energy: 10, weather: '晴' }), current = state({ energy: 9, weather: '晴' })
    const client = new QueryClient()
    client.setQueryData(['reply-state', 'story', 'reply'], { before, after: current })
    const render = (value: StoryState, expanded: boolean) => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(VariablesCard, { storyId: 'story', replyId: 'reply', state: value, expanded, bodyId: 'reply-variables' })))
    const toggle = renderToStaticMarkup(createElement(VariablesToggle, { expanded: false, bodyId: 'reply-variables', onToggle: () => {} }))
    expect(toggle).toContain('aria-label="展开会话变量" aria-expanded="false" aria-controls="reply-variables"')
    expect(render(current, false)).toBe('')
    const html = render(current, true)
    expect(html).toContain('1 组 · 2 项')
    expect(html).toContain('本轮更新 1')
    expect(html).toContain('variable-card-body')
    expect(html).toContain('id="reply-variables"')
    expect(render({ namespaces: {} }, true)).toBe('')
    client.clear()
  })
  it('shows compact before/after values and complete unchanged text without exposing the inspector controls', () => {
    const before = state({ energy: 10, weather: '晴', note: '长内容'.repeat(100), companion: { name: '青禾', ready: false } })
    const current = state({ energy: 9, weather: '晴', note: '长内容'.repeat(100), companion: { name: '青禾', ready: true } })
    const html = renderToStaticMarkup(createElement(VariableValues, { state: current, boundary: { before, after: current }, compact: true }))
    expect(html).toContain('之前值：')
    expect(html).toContain('当前值：')
    expect(html).toContain('<span>10</span>')
    expect(html).toContain('<span>9</span>')
    expect(html).toContain('<span>晴</span>')
    expect(html).toContain('长内容'.repeat(100))
    expect(html).toContain('展开 note 的完整内容')
    expect(html).toContain('data-long="true" data-expanded="false"')
    expect(html).not.toContain('变量定义与维护规则')
    expect(html).not.toContain('查看原值')
    expect(html).not.toContain('variables-toolbar')
  })
})
