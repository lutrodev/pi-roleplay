import { afterEach, expect, it } from 'vitest'
import { StoryFeed } from '../apps/web/src/lib/story-feed.ts'
import type { StoryData } from '../apps/web/src/lib/api.ts'
import { readingView, storyNotice } from '../packages/protocol/src/reading.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { runActivityPhase } from '../apps/web/src/pages/story/run-activity.tsx'
import { fixture, profile } from './helpers.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
function setup() {
  const x = fixture(); cleanup.push(x.close)
  const story = x.stories.create('流式正文', profile()), service = new StoryService(x.stories, x.assets, x.files)
  const { run } = service.send(story.id, 'streaming-turn', [{ text: '续写灯塔故事', attachmentIds: [] }])
  x.stories.setRunStatus(run.id, 'running')
  const snapshot = (): StoryData => ({ ...readingView(x.stories.snapshot(story.id)), runs: x.stories.storyRuns(story.id) })
  const draft = (text: string) => storyNotice(x.stories.saveDraft(run.id, text)!)
  return { ...x, story, run, service, snapshot, draft, feed: new StoryFeed(story.id) }
}

it('assembles real journal deltas, replaces a rewritten draft and preserves Unicode and empty resets', () => {
  const x = setup()
  let state = x.feed.snapshot(x.snapshot())
  for (const text of ['雨停了。', '雨停了。\n\n她推开门。', '雨停了。\n\n她推开门。“欢迎回来。”🌙', '改写：灯仍亮着。', '', '新的正文。']) {
    const notice = x.draft(text)
    state = x.feed.receive(state, notice)!
    expect(state.runs.find(run => run.id === x.run.id)?.draft).toBe(text)
    expect(x.feed.receive(state, notice)).toBe(state)
  }
})

it('does not append an SSE event already covered by a newer snapshot or overwrite a newer streamed suffix', () => {
  const x = setup()
  let state = x.feed.snapshot(x.snapshot())
  state = x.feed.receive(state, x.draft('第一段。'))!
  const second = x.draft('第一段。第二段。'), olderSnapshot = x.snapshot()
  state = x.feed.receive(state, second)!
  state = x.feed.receive(state, x.draft('第一段。第二段。第三段。'))!
  state = x.feed.snapshot(olderSnapshot)
  expect(state.runs[0]?.draft).toBe('第一段。第二段。第三段。')
  expect(x.feed.receive(state, second)).toBe(state)
  const fourth = x.draft('第一段。第二段。第三段。第四段。')
  state = x.feed.snapshot(x.snapshot()) // HTTP is ahead of SSE.
  expect(x.feed.receive(state, fourth)).toBe(state)
  expect(x.feed.snapshot(olderSnapshot).runs[0]?.draft).toBe('第一段。第二段。第三段。第四段。')
})

it('reconciles rewrites and reconnect replay against the snapshot boundary without duplicating prose', () => {
  const x = setup()
  let state = x.feed.snapshot(x.snapshot())
  state = x.feed.receive(state, x.draft('旧正文。'))!
  const beforeRewrite = x.snapshot(), rewritten = x.draft('新正文。')
  state = x.feed.receive(state, rewritten)!
  state = x.feed.receive(state, x.draft('新正文。保留后续。'))!
  state = x.feed.snapshot(beforeRewrite)
  expect(state.runs[0]?.draft).toBe('新正文。保留后续。')
  state = x.feed.snapshot(x.snapshot())
  expect(x.feed.receive(state, rewritten)).toBe(state)
  const tail = x.draft('新正文。保留后续。重连后继续。')
  state = x.feed.receive(state, tail)!
  expect(state.runs[0]?.draft).toBe('新正文。保留后续。重连后继续。')
})

it('retains early deltas until a new run appears in the snapshot, and ignores another story', () => {
  const x = setup(), initial = { ...x.snapshot(), runs: [] }
  let state = x.feed.snapshot(initial)
  const first = x.draft('开始。'), snapshot = x.snapshot(), second = x.draft('开始。继续。')
  state = x.feed.receive(state, first)!
  state = x.feed.receive(state, second)!
  expect(state.runs).toHaveLength(0)
  state = x.feed.snapshot(snapshot)
  expect(state.runs[0]?.draft).toBe('开始。继续。')
  expect(x.feed.receive(state, { ...second, seq: second.seq + 1, storyId: 'other-story', data: { ...second.data, text: '不应出现' } })).toBe(state)
})

it('keeps live tool activity in reading snapshots without transferring tool inputs or results', () => {
  const x = setup(), activity = () => { const data = x.feed.snapshot(x.snapshot()); return runActivityPhase(data.story, data.runs[0], data.activeTools) }
  x.stories.append(x.story.id, { type: 'tool.started', data: { runId: x.run.id, callId: 'child', name: 'rp_run_subagent', arguments: { prompt: '仅供轨迹查看' }, status: 'running' } })
  expect(activity()).toBe('collaborating')
  x.stories.append(x.story.id, { type: 'tool.started', data: { runId: x.run.id, callId: 'writer', parentCallId: 'child', name: 'rp_write_turn', arguments: { brief: '内部写作资料'.repeat(10000) }, status: 'running' } })
  const data = x.snapshot()
  expect(data.story.tools).toEqual([])
  expect(data.activeTools).toEqual([{ runId: x.run.id, name: 'rp_run_subagent' }, { runId: x.run.id, name: 'rp_write_turn' }])
  expect(JSON.stringify(data)).not.toContain('内部写作资料')
  expect(activity()).toBe('writing')
  x.draft('不断增长的正文')
  expect(activity()).toBe('writing')
  x.stories.append(x.story.id, { type: 'tool.finished', data: { callId: 'writer', result: { prose: '内部结果' }, failed: false } })
  expect(activity()).toBe('collaborating')
  x.stories.append(x.story.id, { type: 'tool.finished', data: { callId: 'child', result: {}, failed: false } })
  expect(activity()).toBe('finishing')
  x.stories.setRunStatus(x.run.id, 'completed')
  expect(activity()).toBeNull()
})
