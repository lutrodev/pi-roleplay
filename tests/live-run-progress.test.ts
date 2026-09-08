import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunActivitySnapshot } from '../packages/protocol/src/activity.ts'
import type { RunRecord } from '../packages/rp-core/src/types.ts'
import { RunProgressView, progressPresentation } from '../apps/web/src/pages/story/run-progress.tsx'
import { RunActivity } from '../apps/web/src/pages/story/run-activity.tsx'
import { beginModelProgress, modelProgress } from '../apps/server/src/runtime/live-progress.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { journalStream } from '../apps/server/src/runtime/model-journal.ts'
import { RunJournal } from '../apps/server/src/runtime/journal.ts'
import { TraceService } from '../apps/server/src/services/trace-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { readingView } from '../packages/protocol/src/reading.ts'
import { fixture, profile } from './helpers.ts'
import { streamingTextResponse } from './streaming-response.ts'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(close => close()))
function setup() {
  const x = fixture(); cleanups.push(x.close)
  const story = x.stories.create('实时进展验收', profile())
  const { run } = new StoryService(x.stories, x.assets, x.files).send(story.id, 'progress-test', [{ text: '调查灯塔。', attachmentIds: [] }])
  x.stories.setRunStatus(run.id, 'running')
  return { ...x, story, run: x.stories.run(run.id), journal: new RunJournal(x.stories, x.files, run), trace: new TraceService(x.stories) }
}

describe('live process boundary', () => {
  it('reads real in-flight model text after refresh without persisting prose, then clears on abort', async () => {
    const x = setup(), text = '我会先核对灯塔资料，再让 Writer 继续创作。'.repeat(3)
    const models = new ModelRegistry([{ provider: 'test', model: 'progress', keyEnv: 'TEST', api: 'openai-completions', baseUrl: 'https://synthetic.invalid/v1', contextWindow: 100000, maxTokens: 1000 }], {
      env: () => 'synthetic', fetch: async (_url, init) => streamingTextResponse(text, init?.signal),
    })
    const controller = new AbortController(), model = models.resolve({ provider: 'test', model: 'progress' }).model
    const stream = await journalStream(x.journal, models, 'main')(model, { messages: [{ role: 'user', content: '调查灯塔', timestamp: Date.now() }] }, { signal: controller.signal })
    try {
      await expect.poll(() => x.trace.activity(x.run.id).live[0]?.text.length ?? 0, { timeout: 4000 }).toBeGreaterThanOrEqual(28)
      const snapshot = new TraceService(x.stories).activity(x.run.id)
      expect(snapshot.live[0]).toMatchObject({ phase: 'responding' })
      expect(text.startsWith(snapshot.live[0]!.text)).toBe(true)
      expect(progressPresentation(x.run, snapshot).text).toBe(snapshot.live[0]!.text)
      expect(x.stories.run(x.run.id).draft).toBe('')
      expect(x.stories.eventLog(x.story.id).filter(event => event.type === 'run.draft')).toEqual([])
      expect(JSON.stringify(readingView(x.stories.snapshot(x.story.id)))).not.toContain('我会先核对')
    } finally { controller.abort(); await stream.result() }
    expect(modelProgress(x.stories, x.run.id)).toEqual([])
    x.stories.setRunStatus(x.run.id, 'cancelled')
    expect(x.trace.activity(x.run.id)).toEqual({ runId: x.run.id, requests: [], tools: [], live: [] })
  })

  it('isolates concurrent requests and instances, bounds snippets, and never exposes raw reasoning', () => {
    const x = setup(), y = setup(), first = beginModelProgress(x.stories, x.run.id, 'main'), second = beginModelProgress(x.stories, x.run.id, 'writer')
    const partial = { role: 'assistant' as const, content: [], provider: 'test', model: 'progress', api: 'openai-completions' as const, timestamp: 0, stopReason: 'stop' as const,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    first.update({ type: 'text_delta', contentIndex: 0, delta: '灯🌙'.repeat(400), partial })
    second.update({ type: 'thinking_delta', contentIndex: 0, delta: '内部思考正文', partial })
    const state = modelProgress(x.stories, x.run.id)
    expect([...state[0]!.text]).toHaveLength(320)
    expect(state[1]).toMatchObject({ phase: 'thinking', text: '' })
    expect(modelProgress(y.stories, x.run.id)).toEqual([])
    expect(modelProgress(x.stories, y.run.id)).toEqual([])
    state[0]!.text = '外部修改'; expect(modelProgress(x.stories, x.run.id)[0]!.text).not.toBe('外部修改')
    first.close(); expect(modelProgress(x.stories, x.run.id)).toHaveLength(1)
    second.close(); expect(modelProgress(x.stories, x.run.id)).toEqual([])
    const next = beginModelProgress(x.stories, x.run.id, 'next-request')
    second.close(); expect(modelProgress(x.stories, x.run.id)).toHaveLength(1)
    next.close()
  })

  it('keeps bounded active tool descriptions, without synthetic Writer history, old commentary, or full results', () => {
    const x = setup(), owner = x.journal.callId('request')
    x.journal.model(owner, 'provider:request', { requestId: 'main', scope: 'main', provider: 'test', model: 'main', systemPrompt: '不应公开的系统输入', messages: [] })
    x.journal.model(owner, 'provider:response', { requestId: 'main', scope: 'main', response: { stopReason: 'toolUse', content: [{ type: 'thinking', thinking: '内部推理' }, { type: 'text', text: '接下来核对灯塔记录。' }] } })
    x.stories.append(x.story.id, { type: 'tool.started', data: { runId: x.run.id, callId: 'read-file', name: 'read', arguments: { file_path: 'lighthouse.txt', private: '不应公开的参数' }, status: 'running' } })
    x.journal.model('writer', 'provider:response', { requestId: 'writer', scope: 'writer:one', response: { content: [{ type: 'text', text: 'Writer 正文不应成为过程片段' }] } })
    const state = x.trace.activity(x.run.id)
    expect(state.live).toEqual([])
    expect(state.tools).toEqual([{ callId: 'read-file', name: 'read', status: 'running', parentCallId: undefined, preview: 'lighthouse.txt' }])
    for (const hidden of ['内部推理', '不应公开', 'Writer 正文', '接下来核对灯塔记录']) expect(JSON.stringify(state)).not.toContain(hidden)
    expect(state.requests).toHaveLength(1)
  })
})

describe('two distinct progress surfaces', () => {
  const run: RunRecord = { id: 'run', storyId: 'story', requestId: 'input', inputHash: 'hash', turnId: 'turn', status: 'running', draft: '', error: null, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' }
  const snapshot = (): RunActivitySnapshot => ({ runId: run.id, requests: [{ id: 'main', scope: 'main', model: 'main-model', provider: 'test', status: 'running', startedAt: run.createdAt }], live: [{ requestId: 'main', phase: 'responding', text: '先检查资料，再请 Writer 写作。' }], tools: [] })
  const render = (current = run, data = snapshot(), connection: 'live' | 'reconnecting' = 'live') => renderToStaticMarkup(createElement(RunProgressView, { run: current, snapshot: data, connection }))
  it('renders a live process before any prose exists, without duplicating the reply footer entry or generic spinner', () => {
    const html = render()
    for (const text of ['实时运行进展', '先检查资料']) expect(html).toContain(text)
    expect(html).not.toContain('<button')
    for (const text of ['main-model', '第 1 次模型请求', 'run-progress-heading', 'run-progress-meta']) expect(html).not.toContain(text)
    for (const text of ['draft-message', 'class="prose', 'spinner', '<script']) expect(html).not.toContain(text)
    const footer = renderToStaticMarkup(createElement(RunActivity, { story: { archived: false, messages: [], maintenance: {} }, run, activeTools: [] }))
    expect(footer).toContain('spinner'); expect(footer).toContain('run-activity-duration'); expect(footer).not.toContain('先检查资料')
  })
  it('follows Writer work and its character count without duplicating Writer prose in process text', () => {
    const data = snapshot(); data.requests[0]!.status = 'completed'; data.requests.push({ ...data.requests[0]!, id: 'writer', scope: 'writer:call', status: 'running' })
    data.live = [{ requestId: 'writer', phase: 'responding', text: '真正的正文🌙' }]
    data.tools = [{ callId: 'writer', name: 'rp_write_turn', status: 'running', preview: '' }]
    const current = { ...run, draft: '真正的正文🌙' }, view = progressPresentation(current, data), html = render(current, data)
    expect(view.title).toContain('正在写作 · 6 字'); expect(view.text).toBeUndefined()
    expect(html).not.toContain(current.draft)
  })
  it('stops on terminal runs, ignores another run, and marks disconnected or waiting states honestly', () => {
    for (const status of ['completed', 'cancelled', 'failed', 'interrupted'] as const) expect(render({ ...run, status })).toBe('')
    expect(progressPresentation(run, { ...snapshot(), runId: 'previous' }).text).toBeUndefined()
    expect(render(run, snapshot(), 'reconnecting')).toContain('连接恢复后继续更新实时进展')
    expect(render({ ...run, status: 'waiting_user' })).toContain('需要你确认信息后继续')
    expect(render({ ...run, status: 'queued' })).toContain('请求已排队')
  })
})
