import { expect, it } from 'vitest'
import { fixture, profile } from './helpers.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TraceService } from '../apps/server/src/services/trace-service.ts'
import type { RunRecord } from '../packages/rp-core/src/types.ts'
import { projectConversationRounds } from '../packages/rp-core/src/story/conversation-rounds.ts'

function setup() {
  const x = fixture(), story = x.stories.create('合成轨迹操作', profile())
  const service = new StoryService(x.stories, x.assets, x.files), trace = new TraceService(x.stories)
  const snapshot = () => x.stories.snapshot(story.id)
  const finish = (run: RunRecord, text: string, status: 'completed' | 'failed' | 'cancelled' = 'completed') => {
    x.stories.setRunStatus(run.id, 'running')
    x.stories.append(story.id, { type: 'model.message', data: { runId: run.id, ownerMessageId: 'main', role: 'provider:request', message: { requestId: 'same', scope: 'main', provider: 'test', model: 'test', systemPrompt: '合成系统', messages: [] } } })
    x.stories.append(story.id, { type: 'model.message', data: { runId: run.id, ownerMessageId: 'main', role: 'provider:response', message: { requestId: 'same', response: { stopReason: status === 'completed' ? 'stop' : 'error', content: [{ type: 'text', text }] } } } })
    if (status === 'completed') x.stories.append(story.id, { type: 'message.added', data: { message: { id: `reply-${run.id}`, role: 'assistant', kind: 'message', text, attachmentIds: [], turnId: run.turnId, runId: run.id, createdAt: new Date().toISOString() } } })
    x.stories.setRunStatus(run.id, status)
  }
  const send = (text: string) => { const { run } = service.send(story.id, crypto.randomUUID(), [{ text, attachmentIds: [] }]); finish(run, `${text}的回复`); return run }
  const reroll = (edited?: string) => { const s = snapshot(); return service.regenerate(story.id, s.revision, s.messages.filter(m => m.kind !== 'tool').at(-1)!.id, crypto.randomUUID(), edited).run }
  const remove = (id: string) => service.remove(story.id, snapshot().revision, id)
  return { ...x, story, service, trace, snapshot, finish, send, reroll, remove }
}

it('keeps rerolls and failed/cancelled retries as attempts of the same logical round across reloads', () => {
  const x = setup()
  try {
    const original = x.send('写灯塔'), second = x.reroll(); x.finish(second, '失败记录', 'failed')
    const third = x.reroll(); x.finish(third, '停止记录', 'cancelled')
    const fourth = x.reroll('改写灯塔'); x.finish(fourth, '最新正文')
    const page = new TraceService(x.stories).conversation(x.story.id)
    expect(page.totalRounds).toBe(1); expect(page.rounds).toHaveLength(1)
    expect(page.rounds[0]).toMatchObject({ id: original.id, round: 1, state: 'active', attempts: [
      { runId: original.id, attempt: 1, disposition: 'superseded' }, { runId: second.id, attempt: 2, disposition: 'superseded' },
      { runId: third.id, attempt: 3, disposition: 'superseded' }, { runId: fourth.id, attempt: 4, disposition: 'current' },
    ] })
    expect(JSON.stringify(page.rounds[0]!.trajectory)).not.toContain('失败记录')
    expect(page.rounds[0]!.trajectory.inputPreview).toBe('改写灯塔')
    expect(x.trace.conversation(x.story.id, { around: original.id }).rounds[0]!.trajectory.run.id).toBe(fourth.id)
    expect(x.stories.eventLog(x.story.id).filter(e => e.type === 'messages.removed').at(-1)).toMatchObject({ data: { replacement: { previousRunId: third.id, runId: fourth.id } } })
    // Pre-link journals recover the exact recorded regenerate/copy sequence, without text comparisons.
    const events = x.stories.eventLog(x.story.id).map(event => event.type === 'messages.removed' ? { ...event, data: { messageIds: event.data.messageIds, reason: event.data.reason } } : event)
    expect(projectConversationRounds(events, new Set([original.id, second.id, third.id, fourth.id])).rounds[0]!.attempts).toHaveLength(4)
    expect(x.trace.trajectory(original.id).entries.some(entry => entry.preview.includes('写灯塔的回复'))).toBe(true)
    x.send('下一轮'); expect(x.trace.conversation(x.story.id).rounds.map(round => round.round)).toEqual([1, 2])
  } finally { x.close() }
})

it('deleting an assistant hides its generation while retaining input and recoverable raw history', () => {
  const x = setup()
  try {
    const first = x.send('第一轮'), second = x.send('第二轮')
    x.remove(`reply-${first.id}`)
    const page = x.trace.conversation(x.story.id, { q: '回复' })
    expect(page).toMatchObject({ totalRounds: 1, deletedRounds: 1, totalItems: 1 })
    expect(page.rounds[0]).toMatchObject({ id: first.id, state: 'input-only', attempts: [{ disposition: 'deleted' }] })
    expect(page.rounds[0]!.trajectory.entries.map(entry => entry.kind)).toEqual(['user'])
    expect(page.rounds[0]!.trajectory.requests).toEqual([]); expect(page.rounds[0]!.trajectory.agents).toEqual([]); expect(page.rounds[0]!.trajectory.matches).toEqual([])
    expect(x.trace.trajectory(first.id).entries.some(entry => entry.kind === 'assistant')).toBe(true)
    expect(x.trace.conversation(x.story.id, { deleted: true }).rounds).toMatchObject([{ state: 'input-only' }, { state: 'deleted', trajectory: { run: { id: second.id } } }])
    const retry = x.reroll(); x.finish(retry, '恢复后的正文')
    expect(x.trace.conversation(x.story.id).rounds[0]).toMatchObject({ round: 1, state: 'active', attempts: [{ disposition: 'deleted' }, { disposition: 'current' }] })
  } finally { x.close() }
})

it('clearing then sending uses new effective numbering and immutable cursors without ghost search hits', () => {
  const x = setup()
  try {
    x.send('旧一'); x.send('旧二'); const before = x.trace.conversation(x.story.id), cursor = before.rounds[1]!.cursor
    x.remove(x.snapshot().messages[0]!.id)
    expect(x.trace.conversation(x.story.id)).toMatchObject({ rounds: [], totalRounds: 0, deletedRounds: 2, totalItems: 0 })
    expect(x.trace.conversation(x.story.id, { around: before.rounds[1]!.trajectory.run.id }).rounds).toEqual([])
    const next = x.send('新一'), page = x.trace.conversation(x.story.id, { after: cursor })
    expect(page.rounds).toMatchObject([{ round: 1, trajectory: { run: { id: next.id } } }])
    expect(x.trace.conversation(x.story.id, { q: '旧' }).rounds[0]!.trajectory.matches).toEqual([])
    expect(x.trace.conversation(x.story.id, { deleted: true }).rounds).toHaveLength(3)
    const input = x.snapshot().messages[0]!
    x.service.edit(x.story.id, x.snapshot().revision, input.id, '已修改的输入')
    const edited = x.trace.conversation(x.story.id, { q: '已修改' }).rounds[0]!.trajectory
    const entry = edited.entries.find(entry => entry.kind === 'user')!
    expect(entry.preview).toBe('已修改的输入'); expect(edited.matches).toContain(entry.id)
    expect(entry.detail.type === 'event' && x.trace.event(x.story.id, entry.detail.seq).type).toBe('message.edited')
  } finally { x.close() }
})

it('does not add an attempt for an idempotent regenerate retry or merge an identical new input', () => {
  const x = setup()
  try {
    const original = x.send('同一段输入'), snapshot = x.snapshot(), id = snapshot.messages.at(-1)!.id
    const run = x.service.regenerate(x.story.id, snapshot.revision, id, 'fixed-request').run
    const duplicate = x.service.regenerate(x.story.id, snapshot.revision, id, 'fixed-request')
    expect(duplicate.run.id).toBe(run.id)
    expect(x.trace.conversation(x.story.id).rounds[0]!.attempts).toHaveLength(2)
    x.finish(run, '第二次的正文')
    const next = x.send('同一段输入')
    expect(x.trace.conversation(x.story.id).rounds.map(round => ({ id: round.id, count: round.attempts.length }))).toEqual([{ id: original.id, count: 2 }, { id: next.id, count: 1 }])
  } finally { x.close() }
})
