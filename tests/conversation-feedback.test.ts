import { ErrorNotice } from '../apps/web/src/components/ui.tsx'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { StatusNotice } from '../apps/web/src/components/status-notice.tsx'
import { RunFeedback } from '../apps/web/src/pages/story/run-feedback.tsx'
import { SummaryFeedback } from '../apps/web/src/pages/story/maintenance-feedback.tsx'
import { ReplySuggestions } from '../apps/web/src/pages/story/reply-suggestions.tsx'
import { ApiError } from '../apps/web/src/lib/api.ts'
import { setUiLanguage } from '../apps/web/src/lib/i18n.ts'
import { DEFAULT_PREFERENCES } from '../packages/rp-core/src/settings/preferences.ts'
import type { RunRecord, StorySnapshot } from '../packages/rp-core/src/types.ts'
import { message } from './helpers.ts'

afterEach(() => setUiLanguage('zh'))
const run: RunRecord = { id: 'run', storyId: 'story', requestId: 'request', inputHash: 'input', turnId: 'turn', status: 'failed', draft: '', error: { code: 'MODEL_CONTENT_FILTER', message: '模型提供商的内容过滤中止了本轮生成，尚未提交正文。已有草稿和工具记录已保留。' }, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' }
const lastMessage = { ...message('user', '请检查灯塔的来信。'), runId: run.id, turnId: run.turnId }
const renderRun = (overrides: Partial<Parameters<typeof RunFeedback>[0]> = {}) => renderToStaticMarkup(createElement(RunFeedback, { run, committed: false, draftPersisted: false, lastMessage, disabled: false, highlight: false, revision: 3, ...overrides }))

describe('conversation recovery states', () => {
  it('keeps the provider reason visible and offers regeneration only before commit', () => {
    const failed = renderRun()
    expect(failed).toContain(run.error!.message)
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('重新生成')
    expect(failed).not.toContain('查看本轮轨迹')
    const committed = renderRun({ committed: true })
    expect(committed).toContain('回复已保存，后续过程未完成。')
    expect(committed).not.toContain('重新生成')
    expect(committed).not.toContain('可以重新生成')
  })

  it.each(['cancelled', 'interrupted'] as const)('preserves saved drafts in %s without duplicating them or implying success', status => {
    const html = renderRun({ run: { ...run, status, draft: '' }, draftPersisted: true })
    expect(html).toContain('草稿已保留，尚未提交为正文。')
    expect(html).toContain(status === 'cancelled' ? '已停止生成' : '生成已中断')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('draft-message')
  })

  it('does not offer regeneration of an unrelated or opening message, and respects disabled recovery', () => {
    expect(renderRun({ lastMessage: { ...lastMessage, runId: 'older' } })).not.toContain('重新生成')
    expect(renderRun({ lastMessage: { ...lastMessage, kind: 'opening' } })).not.toContain('重新生成')
    expect(renderRun({ disabled: true }).match(/<button[^>]*retry-generation[^>]*>/)?.[0]).toContain('disabled=""')
    expect(renderRun({ run: { ...run, status: 'completed' } })).toBe('')
  })

  it('retains the full long diagnostic as escaped, expandable text', () => {
    const details = '<script>never execute</script>\n' + '诊断原因。'.repeat(100)
    const html = renderToStaticMarkup(createElement(StatusNotice, { title: '生成未完成', tone: 'error', details }))
    expect(html).toMatch(/<summary>.*查看详细原因<\/summary>/)
    expect(html).toContain('&lt;script&gt;never execute&lt;/script&gt;')
    expect(html).toContain('诊断原因。'.repeat(100))
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<details open')
  })

  it('keeps revision-conflict recovery guidance and translates authored error UI', () => {
    setUiLanguage('en')
    const html = renderToStaticMarkup(createElement(ErrorNotice, { error: new ApiError('原始错误文本', 'REVISION_CONFLICT', 409), retry: () => {} }))
    expect(html).toContain('Content has changed')
    expect(html).toContain('原始错误文本')
    expect(html).toContain('Refresh')
    expect(html).toContain('Retry')
  })
})

describe('auxiliary and empty states', () => {
  it('keeps ready-summary information in its panel without adding a completed warning to the transcript', () => {
    const summary = { id: 'summary', kind: 'summary' as const, status: 'ready' as const, message: '下一轮检查后应用。' }
    expect(renderToStaticMarkup(createElement(SummaryFeedback, { summary }))).toBe('')
    expect(renderToStaticMarkup(createElement(SummaryFeedback, { summary, showReady: true }))).toContain(summary.message)
    expect(renderToStaticMarkup(createElement(SummaryFeedback, { summary: { ...summary, status: 'completed' } }))).toBe('')
    expect(renderToStaticMarkup(createElement(SummaryFeedback, { summary: { ...summary, status: 'discarded' } }))).toContain('本次总结未采用')
  })

  it('ignores stale suggestion failures and preserves usable suggestions after an update fails', () => {
    const last = { ...message('assistant', '灯塔的钟声响起。'), kind: 'narrative' as const }
    const story = { messages: [last], archived: false, replyOptions: {}, maintenance: { 'reply-options': { id: 'suggestions', kind: 'reply-options', status: 'failed', messageId: last.id, message: '模型暂时没有返回建议。' } } } as StorySnapshot
    const render = () => renderToStaticMarkup(createElement(ReplySuggestions, { story, preferences: DEFAULT_PREFERENCES, busy: false, insert: () => {} }))
    expect(render()).toContain('可以直接输入，继续对话。')
    story.replyOptions[last.id] = ['查看旧海图。']
    expect(render()).toContain('回复建议未更新')
    expect(render()).toContain('查看旧海图。')
    story.maintenance['reply-options']!.messageId = 'older'
    expect(render()).not.toContain('模型暂时没有返回建议。')
    story.messages = []; delete story.maintenance['reply-options']!.messageId
    expect(render()).toBe('')
  })
})
