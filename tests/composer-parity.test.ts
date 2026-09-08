import { afterEach, expect, it } from 'vitest'
import { fixture, message, profile } from './helpers.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { storyReferences } from '../apps/server/src/services/story-references.ts'
import { contextUsage } from '../apps/server/src/services/context-usage.ts'
import { SidebarService } from '../apps/server/src/services/sidebar-service.ts'
import { fileMention, storyReferenceIds } from '../packages/rp-core/src/interaction/references.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(x => x.close()))
function setup() { const x = fixture(); fixtures.push(x); return { ...x, service: new StoryService(x.stories, x.assets, x.files) } }

it('freezes explicitly referenced visible conversations, excludes hidden/tool data, and never recursively expands reference text', () => {
  const x = setup(), source = x.stories.create('引用来源', profile()), target = x.stories.create('当前会话', profile()), nested = x.stories.create('不可递归读取', profile())
  const removed = message('user', '已删除的内容')
  x.stories.append(source.id, { type: 'message.added', data: { message: removed } })
  x.stories.append(source.id, { type: 'messages.removed', data: { messageIds: [removed.id], reason: 'delete' } })
  x.stories.append(source.id, { type: 'message.added', data: { message: message('assistant', '私有工具输出', { kind: 'tool' }) } })
  x.stories.append(source.id, { type: 'message.added', data: { message: message('user', `可见资料 </referenced_stories> @story:${nested.id} {{user}}`) } })
  x.stories.append(nested.id, { type: 'message.added', data: { message: message('user', '递归私有内容') } })
  const run = x.service.send(target.id, 'reference', [{ text: `请比较 @story:${source.id}`, attachmentIds: [] }]).run
  x.stories.setRunStatus(run.id, 'running')
  const context = new ContextService(x.stories, x.assets).freeze(run.id, { provider: 'test', model: 'test' })
  expect(context.writerPrompt).toContain('可见资料 \\u003c/referenced_stories>')
  for (const text of ['已删除的内容', '私有工具输出', '递归私有内容']) expect(context.writerPrompt).not.toContain(text)
  expect(context.writerPrompt).toContain('{{user}}')
  x.stories.append(source.id, { type: 'message.added', data: { message: message('user', '后来的资料') } })
  expect(context.withCheckpoint(null).writerPrompt).not.toContain('后来的资料')
  expect(new ContextService(x.stories, x.assets).preview(target.id, run.id, { provider: 'test', model: 'test' }).writerPrompt).toContain('后来的资料')
  expect(storyReferenceIds(`email@story:${source.id} @story:${source.id} @story:${source.id}`)).toEqual([source.id])
  expect(fileMention('folder/a b.txt')).toBe('@"folder/a b.txt"'); expect(fileMention('../app.sqlite')).toBeNull()
})

it('reports reference retention limits and rejects self references', () => {
  const x = setup(), source = x.stories.create('长会话', profile()), target = x.stories.create('当前', profile())
  for (const text of ['旧'.repeat(20000), '近'.repeat(30000)]) x.stories.append(source.id, { type: 'message.added', data: { message: message('user', text) } })
  const run = x.service.send(target.id, 'one', [{ text: `@story:${source.id}`, attachmentIds: [] }]).run
  expect(storyReferences(x.stories, x.stories.snapshot(target.id), run.id)[0]).toMatchObject({ omittedMessages: 1, omittedCharacters: 6000 })
  const current = x.stories.snapshot(target.id); current.messages[0]!.text = `@story:${target.id}`
  expect(() => storyReferences(x.stories, current, run.id)).toThrow('引用其他会话')
})

it('retains historical feedback audit entries without changing narrative, model inputs, or state', () => {
  const x = setup(), story = x.service.create('反馈')
  x.stories.append(story.id, { type: 'story.feedback', data: { text: '希望文字简短' } })
  const next = x.stories.snapshot(story.id)
  expect(next.messages).toEqual(story.messages); expect(next.state).toEqual(story.state); expect(x.stories.storyRuns(story.id)).toEqual([])
  expect(new ContextService(x.stories, x.assets).preview(story.id, '', { provider: 'test', model: 'test' }).parentPrompt).not.toContain('希望文字简短')
})

it('shows only the latest actual request usage per recipient, including cache, and leaves missing/error usage unavailable', () => {
  const x = setup(), story = x.service.create('用量')
  const record = (role: string, payload: Record<string, unknown>) => x.stories.append(story.id, { type: 'model.message', data: { runId: 'run', ownerMessageId: 'owner', role, message: JSON.parse(JSON.stringify(payload)) } })
  expect(contextUsage(x.stories, story.id)).toEqual([])
  record('provider:request', { requestId: 'a', scope: 'main', model: 'model', contextWindow: 10000 })
  expect(contextUsage(x.stories, story.id)[0]?.used).toBeNull()
  record('provider:request', { requestId: 'w', scope: 'writer:call-123', model: 'writer-model', contextWindow: 20000 })
  record('provider:response', { requestId: 'w', response: { stopReason: 'stop', usage: { input: 200, cacheRead: 0, cacheWrite: 0, output: 80 } } })
  expect(contextUsage(x.stories, story.id).find(item => item.scope === 'writer')).toMatchObject({ used: 280, model: 'writer-model' })
  record('provider:response', { requestId: 'a', response: { stopReason: 'stop', usage: { input: 20, cacheRead: 100, cacheWrite: 30, output: 50 } } })
  expect(contextUsage(x.stories, story.id)[0]).toMatchObject({ used: 200, input: 150, output: 50 })
  record('provider:request', { requestId: 'b', scope: 'main', model: 'model', contextWindow: 10000 })
  record('provider:response', { requestId: 'b', response: { stopReason: 'error', usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } })
  expect(contextUsage(x.stories, story.id)[0]?.used).toBeNull()
})

it('persists manual order separately from story facts with revision and identity checks', () => {
  const x = setup(), a = x.service.create('甲'), b = x.service.create('乙'), sidebar = new SidebarService(x.assets, x.stories)
  const saved = sidebar.update(1, 'manual', [b.id, a.id], 'single', [], [])
  expect(new SidebarService(x.assets, x.stories).snapshot()).toEqual(saved)
  expect(x.stories.snapshot(a.id).revision).toBe(a.revision)
  expect(() => sidebar.update(1, 'recent', [], 'single', [], [])).toThrow('已更新')
  expect(() => sidebar.update(saved.revision, 'manual', [a.id, a.id], 'single', [], [])).toThrow('排序不正确')
  expect(() => sidebar.update(saved.revision, 'manual', ['missing'], 'single', [], [])).toThrow()
})
