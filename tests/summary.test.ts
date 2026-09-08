import { afterEach, describe, expect, it } from 'vitest'
import { estimateTextTokens, planSummary, SUMMARY_HEADINGS, summaryStillApplies, validateSummary } from '../packages/rp-core/src/context/summary.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { fixture, message, profile } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => { for (const item of fixtures.splice(0)) item.close() })
function setup() {
  const x = fixture(); fixtures.push(x)
  const story = x.stories.create('长对话', profile())
  const messages = [message('user', '第一轮原文。'.repeat(400), { turnId: 'first' }), message('assistant', '灯塔的灯亮了。'.repeat(400), { turnId: 'first', kind: 'narrative' }),
    message('user', '第二轮请求', { turnId: 'latest' }), message('assistant', '这是对创作约束的说明，并未发生新剧情。', { turnId: 'latest' }),
    message('user', 'CURRENT_INPUT_MUST_NOT_BE_SUMMARIZED', { turnId: 'current', runId: 'current-run' })]
  for (const item of messages) x.stories.append(story.id, { type: 'message.added', data: { message: item } })
  return { ...x, storyId: story.id, messages }
}
const summary = SUMMARY_HEADINGS.map((heading, index) => `${heading}\n- ${index === 0 ? '灯塔的灯已亮起。' : '（无）'}`).join('\n\n')

describe('summary source and validity', () => {
  it('keeps the latest complete exchange for overflow recovery and excludes current input from deferred work', () => {
    const x = setup(), story = x.stories.snapshot(x.storyId)
    const manual = planSummary(story, { currentRunId: 'current-run', retainLatestExchange: true })!
    expect(manual.sourceMessageIds).toEqual(x.messages.slice(0, 2).map(message => message.id))
    const deferred = planSummary(story, { currentRunId: 'current-run', retainLatestExchange: false })!
    expect(deferred.sourceMessageIds).toEqual(x.messages.slice(0, 4).map(message => message.id))
    expect(deferred.prompt).toContain('写作回复'); expect(deferred.prompt).toContain('非写作回复')
    expect(deferred.prompt).not.toContain('CURRENT_INPUT_MUST_NOT_BE_SUMMARIZED')
    expect(validateSummary(summary, manual.originalTokens)).toBe(summary)
  })
  it('combines a valid prior checkpoint with uncovered text, and rejects a changed source before landing', () => {
    const x = setup(), first = planSummary(x.stories.snapshot(x.storyId), { currentRunId: 'current-run', retainLatestExchange: true })!
    x.stories.append(x.storyId, { type: 'summary.created', data: { throughMessageId: first.throughMessageId, sourceMessageIds: first.sourceMessageIds, text: summary } })
    const plan = planSummary(x.stories.snapshot(x.storyId), { currentRunId: 'current-run', retainLatestExchange: false })!
    expect(plan.prompt).toContain('<已有会话总结>'); expect(plan.prompt).not.toContain('第一轮原文。')
    expect(plan.sourceMessageIds).toHaveLength(4)
    expect(summaryStillApplies(x.stories.snapshot(x.storyId), plan)).toBe(true)
    const service = new StoryService(x.stories, x.assets, x.files)
    service.edit(x.storyId, x.stories.snapshot(x.storyId).revision, x.messages[0]!.id, '第一轮事实已修正。')
    expect(summaryStillApplies(x.stories.snapshot(x.storyId), plan)).toBe(false)
    expect(x.stories.snapshot(x.storyId).checkpoint).toBeNull()
    expect(x.stories.snapshot(x.storyId).messages).toHaveLength(5)
  })
  it('does not compact only the newest exchange, and rejects malformed, oversized or ineffective summaries', () => {
    const x = setup(), story = x.stories.snapshot(x.storyId)
    expect(planSummary({ ...story, messages: story.messages.slice(2) }, { currentRunId: 'current-run', retainLatestExchange: true })).toBe(null)
    expect(() => validateSummary('前言\n' + summary, 10000)).toThrow('五个部分')
    expect(() => validateSummary(summary.replace(SUMMARY_HEADINGS[2], '## 其他'), 10000)).toThrow('五个部分')
    expect(() => validateSummary(summary + '长'.repeat(8000), 10000)).toThrow('8000')
    expect(() => validateSummary(summary, estimateTextTokens(summary))).toThrow('没有减少')
    expect(validateSummary(summary.replaceAll('\n', '\r\n'), 10000)).toBe(summary)
  })
})
