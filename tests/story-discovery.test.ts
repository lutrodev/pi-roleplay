import { afterEach, expect, it } from 'vitest'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { searchStories } from '../apps/server/src/services/story-search.ts'
import { projectStory } from '../packages/rp-core/src/story/projection.ts'
import { storyNotice } from '../packages/protocol/src/reading.ts'
import { fixture, message, profile } from './helpers.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
function setup() { const x = fixture(); cleanup.push(x.close); return { ...x, service: new StoryService(x.stories, x.assets, x.files) } }

it('searches visible prose after edits, deletion, regeneration and fork; excludes internal payloads and treats query symbols literally', () => {
  const x = setup(), story = x.stories.create('侦查', profile()), first = message('user', '旧文本 唯一_100%'), reply = message('assistant', 'ÉCOLE 灯塔的记录')
  x.stories.append(story.id, { type: 'message.added', data: { message: first } })
  x.stories.append(story.id, { type: 'message.added', data: { message: reply } })
  x.stories.append(story.id, { type: 'model.message', data: { runId: 'run', ownerMessageId: reply.id, role: 'provider:request', message: { systemPrompt: '只能在内部日志找到' } } })
  expect(searchStories(x.stories, false, '内部日志')).toEqual([])
  expect(searchStories(x.stories, false, '_100%')[0]?.match).toEqual({ messageId: first.id, snippet: first.text })
  expect(searchStories(x.stories, false, 'école')[0]?.match?.messageId).toBe(reply.id)
  x.stories.append(story.id, { type: 'message.edited', data: { messageId: first.id, text: '修改后的港口信息' } })
  expect(searchStories(x.stories, false, '旧文本')).toEqual([])
  expect(searchStories(x.stories, false, '港口')).toHaveLength(1)
  const fork = x.service.fork(story.id, x.stories.snapshot(story.id).revision, reply.id)
  expect(searchStories(x.stories, false, 'école').find(item => item.id === fork.id)?.parentStoryId).toBe(story.id)
  x.stories.append(story.id, { type: 'messages.removed', data: { messageIds: [reply.id], reason: 'regenerate' } })
  expect(searchStories(x.stories, false, 'école').map(item => item.id)).toEqual([fork.id])
  x.service.archive(fork.id, x.stories.snapshot(fork.id).revision, true)
  expect(searchStories(x.stories, false, 'école')).toEqual([])
  expect(searchStories(x.stories, true, 'école')).toHaveLength(1)
})

it('persists feedback as events without changing narrative or variables, supports clearing and forking, and rejects stale or removed targets', () => {
  const x = setup(), story = x.stories.create('反馈', profile()), reply = message('assistant', '她递来一封信。'), user = message('user', '接过信')
  x.stories.append(story.id, { type: 'message.added', data: { message: user } })
  x.stories.append(story.id, { type: 'message.added', data: { message: reply } })
  const current = x.stories.snapshot(story.id)
  const updated = x.service.feedback(story.id, current.revision, reply.id, 'up', '  角色口吻准确  ')
  expect(updated.messages[1]?.feedback).toEqual({ rating: 'up', comment: '角色口吻准确' })
  expect(updated.state).toEqual(current.state); expect(updated.messages[1]?.text).toBe(reply.text)
  expect(() => x.service.feedback(story.id, current.revision, reply.id, 'down', '')).toThrow('已经更新')
  expect(() => x.service.feedback(story.id, updated.revision, user.id, 'up', '')).toThrow('不存在')
  expect(projectStory(x.stories.eventLog(story.id))).toEqual(updated)
  const event = x.stories.eventLog(story.id).at(-1)!
  expect(storyNotice(event).data).toMatchObject({ messageId: reply.id, rating: 'up', comment: '角色口吻准确' })
  const fork = x.service.fork(story.id, updated.revision, reply.id)
  expect(fork.messages[1]?.feedback).toEqual(updated.messages[1]?.feedback)
  const cleared = x.service.feedback(story.id, updated.revision, reply.id, null, '')
  expect(cleared.messages[1]?.feedback).toEqual({ rating: null, comment: '' })
  const removed = x.service.remove(story.id, cleared.revision, reply.id)
  expect(removed.messages).toHaveLength(1)
  expect(() => x.service.feedback(story.id, removed.revision, reply.id, 'up', '')).toThrow('不存在')
})
