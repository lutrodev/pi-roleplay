import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../apps/web/src/components/markdown.tsx'
import { RunFeedback } from '../apps/web/src/pages/story/run-feedback.tsx'
import { ContextRecord } from '../apps/web/src/pages/story/context-record.tsx'
import type { RunRecord, StoryEvent } from '../packages/rp-core/src/types.ts'

describe('reading prose', () => {
  it('colors continuous dialogue across Markdown emphasis, preserving nested quotation and Unicode', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '她说：“请**仔细**读完这封信，\n「别急」。” 夜色渐深。', highlight: true }))
    expect(html).toContain('她说：<span class="dialogue">“请</span><strong><span class="dialogue">仔细</span></strong>')
    expect(html).toContain('<span class="dialogue">读完这封信，\n「别急」。”</span> 夜色渐深。')
    expect(html).not.toContain('class="dialogue"> 夜色')
  })
  it('keeps code and links outside dialogue, discards raw HTML and opens external images through a link', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '“未闭合\n\n普通段落”。\n\n`“code”` [“link”](https://example.com) <script>alert(1)</script>\n\n![海面](https://example.com/sea.png)', highlight: true }))
    expect(html).not.toContain('class="dialogue"')
    expect(html).toContain('<code>“code”</code>')
    expect(html).toContain('rel="noopener noreferrer">“link”</a>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('查看图片：海面')
  })
  it('highlights literal search hits in prose and code without turning them into markup', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '找到蓝色邮戳。\n\n`蓝色邮戳`\n\n<script>蓝色邮戳</script>', search: '蓝色邮戳' }))
    expect(html).toContain('找到<mark>蓝色邮戳</mark>。')
    expect(html).toContain('<code><mark>蓝色邮戳</mark></code>')
    expect(html).not.toContain('<script>')
    const literal = renderToStaticMarkup(createElement(Markdown, { text: '`精确%_[.*]`', search: '%_[.*]' }))
    expect(literal).toContain('精确<mark>%_[.*]</mark>')
  })
})

describe('generation recovery display', () => {
  const run: RunRecord = { id: 'failed-run', storyId: 'story', requestId: 'request', inputHash: 'hash', turnId: 'turn', status: 'failed', draft: '仍然可以继续编辑的草稿。', error: { code: 'TEST', message: '生成已中断' }, createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:01Z' }
  const render = (committed: boolean, draftPersisted: boolean) => renderToStaticMarkup(createElement(RunFeedback, { run, committed, draftPersisted, disabled: false, highlight: false, revision: 4 }))
  it('keeps an unsaved draft visible, without duplicating a recoverable draft already in the transcript', () => {
    expect(render(false, false)).toContain(run.draft)
    expect(render(false, true)).not.toContain(run.draft)
    expect(render(false, true)).toContain('草稿已保留，尚未提交为正文。')
  })
  it('distinguishes a saved reply from a failure before commit', () => {
    const html = render(true, false)
    expect(html).toContain('回复已保存，后续过程未完成。')
    expect(html).not.toContain(run.draft)
    expect(html).not.toContain('草稿尚未提交')
  })
  it('preserves an uncommitted draft while the question card owns the waiting state', () => {
    const renderWaiting = (draftPersisted: boolean, draft = run.draft) => renderToStaticMarkup(createElement(RunFeedback, { run: { ...run, status: 'waiting_user', draft }, committed: false, draftPersisted, disabled: false, highlight: false, revision: 4 }))
    expect(renderWaiting(false)).toContain(run.draft)
    expect(renderWaiting(false)).toContain('回复预览')
    expect(renderWaiting(false)).not.toContain('spinner')
    expect(renderWaiting(false)).not.toContain('等待回答')
    expect(renderWaiting(true)).toBe('')
    expect(renderWaiting(false, '')).toBe('')
  })
  it('shows prose as a preview and leaves progress and inspection to their own surfaces', () => {
    const renderActive = (draft: string, committed = false) => renderToStaticMarkup(createElement(RunFeedback, { run: { ...run, status: 'running', draft, error: null }, committed, draftPersisted: false, disabled: false, highlight: false, revision: 4 }))
    expect(renderActive('')).toBe('')
    expect(renderActive(run.draft, true)).toBe('')
    const html = renderActive(run.draft)
    expect(html).toContain('回复预览')
    expect(html).toContain(run.draft)
    expect(html).not.toContain('查看本轮轨迹')
    expect(html).not.toContain('spinner')
    expect(html).not.toContain('role="status"')
    expect(html).not.toContain('草稿尚未提交')
  })
})

describe('frozen context display', () => {
  it('shows literal prompt text and preserves the full original record for inspection', () => {
    const event: StoryEvent = { seq: 3, storyId: 'story', createdAt: '2026-09-06T00:00:00Z', type: 'context.built', data: { runId: 'run', model: { provider: 'provider', model: 'model' }, parentPrompt: '<section>第一行\n第二行</section>', writerPrompt: 'Writer 原文', systemPrompt: '系统规则', sources: [], attachmentIds: ['file-a'] } }
    const html = renderToStaticMarkup(createElement(ContextRecord, { event }))
    expect(html).toContain('<pre>&lt;section&gt;第一行\n第二行&lt;/section&gt;</pre>')
    expect(html).toContain('主模型上下文')
    expect(html).toContain('Writer 原文')
    expect(html).toContain('原始记录')
    expect(html).toContain('file-a')
    expect(html).not.toContain('<section>第一行')
  })
})
