import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../packages/rp-core/src/types.ts'
import type { ActiveTool } from '../packages/protocol/src/reading.ts'
import { RunActivity, runActivityPhase } from '../apps/web/src/pages/story/run-activity.tsx'
import { message } from './helpers.ts'

const run = (status: RunRecord['status'] = 'running'): RunRecord => ({ id: 'current', storyId: 'story', requestId: 'request', inputHash: 'hash', turnId: 'turn', status, draft: '', error: null, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' })
const story = (): Parameters<typeof runActivityPhase>[0] => ({ archived: false, messages: [], maintenance: {} })
const tool = (name: string, runId = 'current'): ActiveTool => ({ runId, name })
const phase = (state: ReturnType<typeof story>, current: RunRecord | undefined, tools: ActiveTool[] = [], connection: 'live' | 'reconnecting' = 'live') => runActivityPhase(state, current, tools, connection)

describe('activity at the end of the conversation transcript', () => {
  it('leaves reconnect feedback to the conversation instead of repeating it at the reply footer', () => {
    expect(renderToStaticMarkup(createElement(RunActivity, { story: story(), run: run(), activeTools: [], connection: 'reconnecting' }))).toBe('')
  })
  it('stays present from queueing through streamed prose and post-commit work, until the run completes', () => {
    const state = story(), current = run('queued')
    expect(phase(state, current)).toBe('queued')
    current.status = 'running'
    expect(phase(state, current)).toBe('preparing')
    const tools = [tool('rp_write_turn')]
    current.draft = '正在展开的第一段。'
    expect(phase(state, current, tools)).toBe('writing')
    current.draft += '\n\n不断增长的第二段。'
    expect(phase(state, current, tools)).toBe('writing')
    tools.pop()
    expect(phase(state, current, tools)).toBe('finishing')
    state.messages.push({ ...message('assistant', current.draft), kind: 'narrative', runId: current.id })
    current.draft = ''
    expect(phase(state, current)).toBe('finishing')
    current.status = 'completed'
    expect(phase(state, current)).toBeNull()
  })

  it('uses only current running tools and tracks Writer work within a subagent', () => {
    const state = story(), current = run(), tools = [tool('rp_write_turn', 'previous')]
    expect(phase(state, current, tools)).toBe('preparing')
    tools.push(tool('read'))
    expect(phase(state, current, tools)).toBe('working')
    tools.pop(); tools.push(tool('rp_run_subagent'))
    expect(phase(state, current, tools)).toBe('collaborating')
    tools.push(tool('rp_write_turn'))
    expect(phase(state, current, tools)).toBe('writing')
  })

  it.each(['failed', 'cancelled', 'interrupted', 'completed'] as const)('stops animating after %s even if an older tool snapshot still says running', status => {
    const state = story(), activeTools = [tool('rp_write_turn')]
    expect(phase(state, run(status), activeTools)).toBeNull()
    expect(renderToStaticMarkup(createElement(RunActivity, { story: state, run: run(status), activeTools }))).toBe('')
  })

  it('shows a static invitation when waiting for an answer and resumes progress afterwards', () => {
    const state = story(), current = run('waiting_user'), activeTools = [tool('ask_user_question')]
    const html = renderToStaticMarkup(createElement(RunActivity, { story: state, run: current, activeTools }))
    expect(html).toContain('等待你的回答')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).not.toContain('spinner')
    current.status = 'running'; activeTools.pop()
    expect(phase(state, current, activeTools)).toBe('preparing')
  })

  it('keeps option generation within the active commit and has no post-completion suggestion phase', () => {
    const reply = { ...message('assistant', '已完成正文'), kind: 'narrative' as const, runId: 'current' }, state = { ...story(), messages: [reply] }
    state.maintenance['reply-options'] = { id: 'options', kind: 'reply-options', status: 'running', messageId: reply.id, runId: 'current' }
    expect(phase(state, run('running'), [{ name: 'rp_commit_turn', runId: 'current' } as ActiveTool])).toBe('finishing')
    expect(phase(state, run('completed'))).toBeNull()
    state.maintenance['reply-options'].status = 'completed'
    expect(phase(state, run('completed'))).toBeNull()
    state.maintenance['reply-options'].status = 'running'
    state.messages.push({ ...reply, id: 'new-reply' })
    expect(phase(state, run('completed'))).toBeNull()
  })

  it('covers active context summaries and independent manual summaries, but not a ready candidate', () => {
    const state = story()
    state.maintenance.summary = { id: 'summary', kind: 'summary', trigger: 'pressure', status: 'running', runId: 'current' }
    expect(phase(state, run())).toBe('summary')
    state.maintenance.summary.status = 'ready'
    expect(phase(state, run('completed'))).toBeNull()
    state.maintenance.summary = { id: 'manual-summary', kind: 'summary', trigger: 'manual', status: 'running' }
    expect(phase(state, run('cancelled'))).toBe('summary')
    expect(renderToStaticMarkup(createElement(RunActivity, { story: state, run: run('cancelled'), activeTools: [] }))).toBe('')
    expect(renderToStaticMarkup(createElement(RunActivity, { story: state, run: run('queued'), activeTools: [] }))).toContain('等待开始…')
    state.maintenance.summary.status = 'completed'
    expect(phase(state, run('cancelled'))).toBeNull()
  })

  it('communicates uncertain progress during reconnects and does not create activity for idle or archived stories', () => {
    const state = story()
    expect(phase(state, run(), [], 'reconnecting')).toBe('reconnecting')
    expect(phase(state, run())).toBe('preparing')
    expect(phase(state, undefined, [], 'reconnecting')).toBeNull()
    expect(phase({ ...state, archived: true }, run())).toBeNull()
  })
})
