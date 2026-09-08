import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { roundTraceEntries, RoundTraceLink } from '../apps/web/src/pages/story/trace-entry.tsx'
import { RunFeedback } from '../apps/web/src/pages/story/run-feedback.tsx'
import { RunProgressView } from '../apps/web/src/pages/story/run-progress.tsx'
import type { RunRecord } from '../packages/rp-core/src/types.ts'
import { message } from './helpers.ts'

const run: RunRecord = { id: 'current', storyId: 'story', requestId: 'request', inputHash: 'hash', turnId: 'turn', status: 'completed', draft: '', error: null, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:01Z' }
const previous = message('assistant', '上一轮已经完成。', { runId: 'previous' })
const input = message('user', '继续查看来信。', { runId: run.id })
const reply = message('assistant', '信纸上还留着新的线索。', { runId: run.id })
const messages = [previous, input, reply]

describe('one stable trace entry per visible round', () => {
  it('anchors each round to its final visible reply, excluding user input, opening and tool records', () => {
    const opening = message('assistant', '开场', { kind: 'opening', runId: 'opening-run' })
    const commentary = message('assistant', '较早的回复', { runId: run.id })
    const tool = message('assistant', '', { kind: 'tool', runId: run.id })
    const entries = roundTraceEntries([opening, previous, input, commentary, reply, tool], run)
    expect([...entries.messages]).toEqual([[previous.id, 'previous'], [reply.id, run.id]])
    expect(entries.pending).toBeNull()
  })

  it.each(['failed', 'interrupted', 'cancelled'] as const)('keeps the %s entry under its saved draft, with recovery controls only in feedback', status => {
    const current = { ...run, status }, draft = { ...reply, kind: 'draft' as const }
    const entries = roundTraceEntries([previous, input, draft], current)
    expect([...entries.messages]).toEqual([[previous.id, 'previous'], [draft.id, run.id]])
    expect(entries.pending).toBeNull()
    const html = renderToStaticMarkup(createElement(RunFeedback, { run: current, committed: false, draftPersisted: true, lastMessage: draft, disabled: false, highlight: false, revision: 5 }))
    expect(html).not.toContain('data-trace-run-id')
    expect(html).toContain('重新生成')
    expect(html).not.toContain('draft-message')
  })

  it.each(['queued', 'running', 'waiting_user', 'failed', 'interrupted', 'cancelled', 'completed'] as const)('reserves a single reply footer before prose exists in %s, then transfers it to the saved reply', status => {
    const current = { ...run, status, draft: reply.text }
    const pending = roundTraceEntries([previous, input], current)
    expect([...pending.messages]).toEqual([[previous.id, 'previous']])
    expect(pending.pending).toBe(run.id)
    const saved = roundTraceEntries(messages, current)
    expect(saved.messages.get(reply.id)).toBe(run.id)
    expect(saved.pending).toBeNull()
    const progress = renderToStaticMarkup(createElement(RunProgressView, { run: current, connection: 'live' }))
    const feedback = renderToStaticMarkup(createElement(RunFeedback, { run: current, committed: false, draftPersisted: false, disabled: false, highlight: false, revision: 5 }))
    expect(progress + feedback).not.toContain('data-trace-run-id')
    const footer = renderToStaticMarkup(createElement(RoundTraceLink, { runId: pending.pending!, inspect() {} }))
    expect(footer.match(/data-trace-run-id="current"/g)).toHaveLength(1)
    expect(footer).toContain('查看本轮轨迹')
  })

  it('keeps a saved reply anchor across follow-up failure, completion and the next round', () => {
    const current = { ...run, status: 'failed' as const }
    expect(roundTraceEntries(messages, current).messages.get(reply.id)).toBe(run.id)
    const html = renderToStaticMarkup(createElement(RunFeedback, { run: current, committed: true, draftPersisted: false, disabled: false, highlight: false, revision: 5 }))
    expect(html).not.toContain('data-trace-run-id')
    expect(html).not.toContain('重新生成')
    expect(html).not.toContain('status-notice-actions')
    expect(roundTraceEntries(messages, run).messages.get(reply.id)).toBe(run.id)
    expect(roundTraceEntries(messages, { id: 'next' }).messages.get(reply.id)).toBe(run.id)
  })
})
