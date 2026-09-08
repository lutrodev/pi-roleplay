import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Fastify from 'fastify'
import { afterEach, expect, it } from 'vitest'
import { fixture, profile } from './helpers.ts'
import { TraceService } from '../apps/server/src/services/trace-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { registerTrace } from '../apps/server/src/http/trace.ts'
import { TracePanel } from '../apps/web/src/pages/story/trace.tsx'
import { conversationRounds, traceKey } from '../apps/web/src/pages/story/trajectory/conversation.ts'
import type { StoryTrajectory } from '../packages/protocol/src/trace.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
function setup(count = 16) {
  const x = fixture(); cleanup.push(x.close)
  const story = x.stories.create('连续轨迹', profile()), service = new StoryService(x.stories, x.assets, x.files), trace = new TraceService(x.stories)
  const ids: string[] = []
  for (let i = 1; i <= count; i++) {
    const { run } = service.send(story.id, `round-${i}`, [{ text: `第 ${i} 轮输入`, attachmentIds: [] }]); ids.push(run.id)
    x.stories.setRunStatus(run.id, 'running')
    // Reused request IDs are deliberately confined to their owning run.
    x.stories.append(story.id, { type: 'model.message', data: { runId: run.id, ownerMessageId: 'main', role: 'provider:request', message: { requestId: 'same-request', scope: 'main', provider: 'test', model: `model-${i}`, systemPrompt: '合成测试系统提示', messages: [] } } })
    x.stories.append(story.id, { type: 'model.message', data: { runId: run.id, ownerMessageId: 'main', role: 'provider:response', message: { requestId: 'same-request', elapsedMs: 100, response: { stopReason: 'stop', content: [{ type: 'text', text: i === 1 || i === 15 ? `独特%_跨轮检索 ${i}` : `第 ${i} 轮正式回复` }] } } } })
    x.stories.setRunStatus(run.id, i === 3 ? 'cancelled' : 'completed')
  }
  // Equal timestamps must not reorder rounds by UUID. Creation events remain the source of order.
  x.database.sqlite.prepare('UPDATE runs SET created_at = ? WHERE story_id = ?').run('2026-09-07T08:00:00.000Z', story.id)
  return { ...x, story, service, trace, ids }
}
it('paginates a conversation in durable chronological order and retains stopped rounds and stable cursors', () => {
  const x = setup(), page = x.trace.conversation(x.story.id)
  expect(page.totalRounds).toBe(16)
  expect(page.rounds.map(round => round.round)).toEqual(Array.from({ length: 12 }, (_, i) => i + 5))
  expect(page.rounds.map(round => round.trajectory.run.id)).toEqual(x.ids.slice(4))
  expect(page.beforeCursor).toBe(page.rounds[0]!.cursor); expect(page.afterCursor).toBeNull()
  const earlier = x.trace.conversation(x.story.id, { before: page.beforeCursor!, limit: 12 })
  expect(earlier.rounds.map(round => round.round)).toEqual([1, 2, 3, 4]); expect(earlier.rounds[2]!.trajectory.run.status).toBe('cancelled')
  const cursor = page.rounds.at(-1)!.cursor
  const added = x.service.send(x.story.id, 'later', [{ text: '新轮次', attachmentIds: [] }])
  expect(x.trace.conversation(x.story.id, { after: cursor }).rounds).toMatchObject([{ round: 17, trajectory: { run: { id: added.run.id, status: 'queued' } } }])
  expect(x.trace.conversation(x.story.id, { before: page.beforeCursor! }).rounds.map(round => round.trajectory.run.id)).toEqual(x.ids.slice(0, 4))
})
it('loads a window around a requested round, searches every page literally, and keeps detail ownership', () => {
  const x = setup(), around = x.trace.conversation(x.story.id, { around: x.ids[7], limit: 4 })
  expect(around.rounds.map(round => round.round)).toEqual([6, 7, 8, 9])
  expect(around).toMatchObject({ beforeCursor: around.rounds[0]!.cursor, afterCursor: around.rounds.at(-1)!.cursor })
  expect(x.trace.conversation(x.story.id, { after: around.afterCursor!, limit: 3 }).rounds.map(round => round.round)).toEqual([10, 11, 12])
  const pages: StoryTrajectory[] = [x.trace.conversation(x.story.id, { q: '%_跨轮检索' })]
  while (pages[0]!.beforeCursor) pages.unshift(x.trace.conversation(x.story.id, { before: pages[0]!.beforeCursor!, q: '%_跨轮检索' }))
  const matches = conversationRounds(pages).filter(round => round.trajectory.matches.includes('request:same-request'))
  expect(matches.map(round => round.round)).toEqual([1, 15])
  expect(matches.map(round => traceKey(round.trajectory.run.id, 'request:same-request'))[0]).not.toBe(traceKey(matches[1]!.trajectory.run.id, 'request:same-request'))
  expect(JSON.stringify(x.trace.request(matches[0]!.trajectory.run.id, 'same-request'))).toContain('独特%_跨轮检索 1')
  expect(JSON.stringify(x.trace.request(matches[1]!.trajectory.run.id, 'same-request'))).toContain('独特%_跨轮检索 15')
  expect(conversationRounds([pages[0]!, pages[0]!, ...pages.slice(1)])).toHaveLength(16)
})
it('rejects foreign anchors and malformed cursors and returns an empty conversation without phantom rounds', async () => {
  const x = setup(1), other = x.stories.create('另一会话', profile())
  expect(x.trace.conversation(other.id)).toMatchObject({ rounds: [], totalRounds: 0, deletedRounds: 0, totalItems: 0, beforeCursor: null, afterCursor: null })
  expect(() => x.trace.conversation(other.id, { around: x.ids[0] })).toThrow('不属于')
  expect(() => x.trace.conversation(x.story.id, { after: 1, before: 1 })).toThrow('位置不正确')
  expect(() => x.trace.conversation(x.story.id, { after: -1 })).toThrow('位置不正确')
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } }); registerTrace(app, x.trace)
  try {
    const valid = await app.inject(`/api/stories/${x.story.id}/trajectory?limit=1`)
    expect(valid.statusCode).toBe(200); expect(valid.json().rounds[0].round).toBe(1)
    for (const query of ['limit=31', 'before=0', 'after=-1', 'unknown=true']) expect((await app.inject(`/api/stories/${x.story.id}/trajectory?${query}`)).statusCode).toBe(400)
  } finally { await app.close() }
})
it('renders multiple rounds with a left rail and namespaced rows, without a one-round picker', () => {
  const x = setup(3), page = x.trace.conversation(x.story.id), client = new QueryClient()
  client.setQueryData(['story-trajectory', x.story.id, '', null, false], { pages: [page], pageParams: [{}] })
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(TracePanel, {
    story: x.stories.snapshot(x.story.id), runs: x.stories.storyRuns(x.story.id), runId: null, onRunChange: () => {}, visible: false, returnToConversation: () => {},
  })))
  expect(html).not.toContain('选择执行轮次')
  for (let i = 1; i <= 3; i++) {
    expect(html).toContain(`aria-label="第 ${i} 轮"`)
    expect(html).toContain(`data-entry-id="${x.ids[i - 1]}/request:same-request"`)
    expect(html).toContain(`model-${i}`)
  }
  expect(html).toContain('trajectory-round-rail'); expect(html).toContain('共 3 轮')
  client.clear()
})

it('discards cached pages predating a structural edit instead of resurrecting removed rounds', () => {
  const x = setup(3), stale = x.trace.conversation(x.story.id)
  x.service.remove(x.story.id, x.stories.snapshot(x.story.id).revision, x.stories.snapshot(x.story.id).messages[1]!.id)
  const current = x.trace.conversation(x.story.id)
  expect(conversationRounds([stale, current]).map(round => round.trajectory.run.id)).toEqual([x.ids[0]])
})
