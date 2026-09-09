import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { StoryRepository } from '../apps/server/src/storage/story-repository.ts'
import { projectStory, messageTail, regenerationInput } from '../packages/rp-core/src/story/projection.ts'
import { replyState } from '../packages/rp-core/src/story/reply-state.ts'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import type { StoryEventInput } from '../packages/rp-core/src/types.ts'
import { fixture, message, profile } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => { for (const item of fixtures.splice(0)) item.close() })
function setup() { const item = fixture(); fixtures.push(item); return item }
function state(value: number, revision = 1) {
  return { ...createNamespaceSnapshot({ initialValue: { energy: 10 }, value: { energy: value }, definition: {
    title: '故事', updateMode: 'schema-only', schema: { type: 'object', properties: { energy: { type: 'number' } }, required: ['energy'], additionalProperties: false }, rules: [],
  } }), revision }
}

describe('SQLite journal and story projection', () => {
  it('rejects an oversized bootstrap before creating a story or its events', () => {
    const x = setup(), namespaces = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`group${index}`, state(10)]))
    expect(() => x.stories.create('超限变量', profile(), { namespaces })).toThrow(expect.objectContaining({ code: 'STATE_NAMESPACE_LIMIT' }))
    expect(x.stories.list()).toEqual([])
    expect(x.database.sqlite.prepare('SELECT count(*) AS count FROM events').get()).toEqual({ count: 0 })
  })
  it('upgrades an existing version-one database in place without rewriting its story', () => {
    const x = setup(), story = x.stories.create('旧版本故事', profile())
    x.database.sqlite.exec('DROP TABLE deleted_stories; DROP TABLE background_images; DROP TABLE workspaces; DROP TABLE pending_inputs; DROP INDEX events_story_type_cursor; DROP INDEX events_story_run_cursor; DROP INDEX events_story_call_cursor; DELETE FROM __rp_migrations WHERE version > 1;')
    x.database.sqlite.exec("CREATE UNIQUE INDEX runs_one_active_global ON runs((1)) WHERE status IN ('running','waiting_user')")
    x.database.close()
    const reopened = new AppDatabase(x.filename)
    try {
      expect(new StoryRepository(reopened).snapshot(story.id)).toEqual(story)
      expect(reopened.sqlite.prepare('SELECT version FROM __rp_migrations ORDER BY version').all()).toEqual(Array.from({ length: 9 }, (_, index) => ({ version: index + 1 })))
      expect(reopened.sqlite.prepare('SELECT * FROM deleted_stories').all()).toEqual([])
      expect(reopened.sqlite.prepare('SELECT count(*) AS count FROM pending_inputs').get()).toEqual({ count: 0 })
      expect(reopened.sqlite.prepare('SELECT count(*) AS count FROM background_images').get()).toEqual({ count: 0 })
      expect(reopened.sqlite.prepare("EXPLAIN QUERY PLAN SELECT seq FROM events WHERE story_id = ? AND type = 'context.built' AND json_extract(data, '$.runId') = ? ORDER BY seq DESC LIMIT 1").all(story.id, 'run')).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('events_story_run_cursor') })]))
    } finally { reopened.close() }
  })
  it('preserves projection revisions while loading large diagnostic payloads only for the requested run', () => {
    const { stories } = setup(), story = stories.create('长记录', profile())
    const input = message('user', '继续')
    stories.append(story.id, { type: 'message.added', data: { message: input } })
    const large = '诊断数据'.repeat(20000)
    for (let index = 0; index < 12; index++) {
      stories.append(story.id, { type: 'context.built', data: { runId: `run-${index}`, writerPrompt: large, parentPrompt: large, sources: [], model: { provider: 'test', model: 'test' } } })
      stories.append(story.id, { type: 'model.message', data: { runId: `run-${index}`, ownerMessageId: input.id, role: 'test', message: { text: large } } })
    }
    expect(stories.projectionEvents(story.id)).toHaveLength(2)
    expect(stories.snapshot(story.id)).toEqual(projectStory(stories.eventLog(story.id)))
    const requested = stories.eventsOfTypes(story.id, ['context.built'], { field: 'runId', value: 'run-7' })
    expect(requested).toHaveLength(1)
    expect(stories.latestRunEvent(story.id, 'run-7', 'context.built')).toMatchObject(requested[0]!)
  })
  it('persists a complete story and recovers solely from the journal after reopening', () => {
    const { database, stories, filename } = setup()
    const story = stories.create('潮汐', profile(), { namespaces: { story: state(10) } })
    const user = message('user', '走向灯塔。', { attachmentIds: ['image-a', 'file-b'] })
    stories.append(story.id, { type: 'message.added', data: { message: user } })
    const expected = stories.snapshot(story.id)
    expect(database.sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    database.close()
    const restored = new AppDatabase(filename)
    try { expect(new StoryRepository(restored).snapshot(story.id)).toEqual(expected) }
    finally { restored.close() }
  })

  it('rolls back events and index changes together if any transaction step fails', () => {
    const { database, stories } = setup()
    const story = stories.create('原始标题', profile())
    expect(() => database.transaction(() => {
      stories.append(story.id, { type: 'story.renamed', data: { title: '不应保存' } })
      stories.append(story.id, { type: 'message.added', data: { message: message('assistant', '不应提交') } })
      throw new Error('simulated disk-boundary failure')
    })).toThrow('disk-boundary')
    expect(stories.snapshot(story.id)).toEqual(story)
    expect(stories.list()[0]?.title).toBe('原始标题')
  })

  it('preserves effects on edit and removes their entire visible tail on deletion', () => {
    const { stories } = setup()
    const story = stories.create('灯塔', profile(), { namespaces: { story: state(10) } })
    const user = message('user', '上楼。')
    const reply = message('assistant', '你沿楼梯而上。', { turnId: user.turnId, kind: 'narrative', runId: 'run-a' })
    stories.append(story.id, { type: 'message.added', data: { message: user } })
    stories.append(story.id, { type: 'message.added', data: { message: { ...reply, kind: 'tool', text: '' } } })
    const commit: StoryEventInput = { type: 'turn.committed', data: {
      commitId: 'commit-a', fingerprint: 'digest-a', runId: 'run-a', message: reply, summary: '主角登塔', effects: [],
      stateUpdates: [{ namespace: 'story', snapshot: state(9, 2) }], references: [], extensions: {},
    } }
    stories.append(story.id, commit, 'commit:commit-a')
    expect(replyState(stories.eventLog(story.id), reply.id)).toMatchObject({ before: { namespaces: { story: { value: { energy: 10 } } } }, after: { namespaces: { story: { value: { energy: 9 } } } } })
    stories.append(story.id, { type: 'message.edited', data: { messageId: reply.id, text: '改为更简洁的正文。' } })
    expect(stories.snapshot(story.id).state.namespaces.story?.value).toEqual({ energy: 9 })
    expect(replyState(stories.eventLog(story.id), reply.id).after.namespaces.story?.value).toEqual({ energy: 9 })
    const before = stories.eventLog(story.id).length
    stories.append(story.id, { type: 'messages.removed', data: { messageIds: messageTail(stories.snapshot(story.id), user.id), reason: 'delete' } })
    const result = stories.snapshot(story.id)
    expect(result.messages).toEqual([])
    expect(result.state.namespaces.story?.value).toEqual({ energy: 10 })
    expect(result.summaries).toEqual([])
    expect(stories.eventLog(story.id)).toHaveLength(before + 1)
    expect(() => replyState(stories.eventLog(story.id), reply.id)).toThrow('已不存在')
  })

  it('keeps variable configuration tied to the assistant that owns it', () => {
    const { stories } = setup()
    const story = stories.create('变量配置', profile())
    const owner = message('assistant', '已设置精力。', { kind: 'tool' })
    stories.append(story.id, { type: 'message.added', data: { message: owner } })
    stories.append(story.id, { type: 'state.configured', data: { ownerMessageId: owner.id, update: { namespace: 'story', snapshot: state(10) } } })
    stories.append(story.id, { type: 'message.edited', data: { messageId: owner.id, text: '已准备好。' } })
    expect(stories.snapshot(story.id).state.namespaces.story?.value).toEqual({ energy: 10 })
    stories.append(story.id, { type: 'messages.removed', data: { messageIds: [owner.id], reason: 'regenerate' } })
    expect(stories.snapshot(story.id).state.namespaces).toEqual({})
  })

  it('recovers every current user input and attachment when regenerating the last turn', () => {
    const { stories } = setup()
    const story = stories.create('重试', profile())
    const first = message('user', '先看图片', { attachmentIds: ['picture'], turnId: 'turn-a' })
    const second = message('user', '再看文档', { attachmentIds: ['document'], turnId: 'turn-a' })
    const reply = message('assistant', '中断的回复', { turnId: 'turn-a' })
    for (const item of [first, second, reply]) stories.append(story.id, { type: 'message.added', data: { message: item } })
    stories.append(story.id, { type: 'message.edited', data: { messageId: first.id, text: '请先查看图片' } })
    const result = regenerationInput(stories.snapshot(story.id), reply.id)
    expect(result.inputs.map(item => [item.text, item.attachmentIds])).toEqual([['请先查看图片', ['picture']], ['再看文档', ['document']]])
    expect(result.removeIds).toEqual([first.id, second.id, reply.id])
    expect(() => regenerationInput(stories.snapshot(story.id), first.id)).toThrow('最后一条')
  })

  it('rejects stale edits and malformed event ordering rather than guessing', () => {
    const { stories } = setup()
    const story = stories.create('并发编辑', profile())
    stories.mutate(story.id, story.revision, () => stories.append(story.id, { type: 'story.renamed', data: { title: '已更新' } }))
    expect(() => stories.mutate(story.id, story.revision, () => undefined)).toThrow('已经更新')
    const journal = stories.eventLog(story.id)
    expect(() => projectStory([...journal].reverse())).toThrow()
    expect(() => projectStory([...journal, journal[0]!])).toThrow('顺序')
  })

  it('invalidates summaries when any source message is removed', () => {
    const { stories } = setup()
    const story = stories.create('总结', profile())
    const first = message('user', '第一段')
    const second = message('assistant', '第二段')
    for (const item of [first, second]) stories.append(story.id, { type: 'message.added', data: { message: item } })
    stories.append(story.id, { type: 'summary.created', data: { throughMessageId: second.id, sourceMessageIds: [first.id, second.id], text: '两段总结' } })
    expect(stories.snapshot(story.id).checkpoint?.text).toBe('两段总结')
    stories.append(story.id, { type: 'messages.removed', data: { messageIds: [second.id], reason: 'delete' } })
    expect(stories.snapshot(story.id).checkpoint).toBeNull()
  })
})

describe('durable execution queue', () => {
  it('deduplicates accepted messages and rejects reuse with different content', () => {
    const { stories } = setup()
    const story = stories.create('发送', profile())
    const input = { storyId: story.id, requestId: 'request-a', inputHash: 'hash-a', turnId: 'turn-a' }
    let accepted = 0
    const first = stories.enqueue(input, () => { accepted++ })
    const second = stories.enqueue(input, () => { accepted++ })
    expect(second).toEqual({ run: first.run, duplicate: true })
    expect(accepted).toBe(1)
    expect(() => stories.enqueue({ ...input, inputHash: 'different' }, () => {})).toThrow('不同内容')
    expect(() => stories.enqueue({ ...input, requestId: 'request-b' }, () => {})).toThrow('等待')
  })

  it('runs independent stories concurrently, serializes each story and rejects illegal transitions', () => {
    const { stories } = setup()
    const first = stories.create('一', profile()), second = stories.create('二', profile())
    const a = stories.enqueue({ storyId: first.id, requestId: 'a', inputHash: 'a', turnId: 'a' }, () => {}).run
    const b = stories.enqueue({ storyId: second.id, requestId: 'b', inputHash: 'b', turnId: 'b' }, () => {}).run
    stories.setRunStatus(a.id, 'running')
    expect(stories.nextQueued()?.id).toBe(b.id)
    stories.setRunStatus(b.id, 'running')
    expect(stories.run(b.id).status).toBe('running')
    expect(() => stories.enqueue({ storyId: first.id, requestId: 'c', inputHash: 'c', turnId: 'c' }, () => {})).toThrow('等待')
    stories.setRunStatus(a.id, 'waiting_user')
    stories.setRunStatus(a.id, 'running')
    stories.setRunStatus(a.id, 'completed')
    expect(stories.nextQueued()).toBeUndefined()
    expect(() => stories.setRunStatus(a.id, 'running')).toThrow('状态')
  })

  it('upgrades the global lock in version eight without changing events or the per-story lock', () => {
    const x = setup(), story = x.stories.create('升级中的会话', profile())
    const a = x.stories.enqueue({ storyId: story.id, requestId: 'a', inputHash: 'a', turnId: 'a' }, () => {}).run
    x.stories.setRunStatus(a.id, 'running'); x.stories.saveDraft(a.id, '升级前的草稿')
    const events = x.stories.eventLog(story.id), run = x.stories.run(a.id)
    x.database.sqlite.exec("CREATE UNIQUE INDEX runs_one_active_global ON runs((1)) WHERE status IN ('running','waiting_user'); DELETE FROM __rp_migrations WHERE version = 9")
    x.database.close()
    const database = new AppDatabase(x.filename), stories = new StoryRepository(database)
    try {
      expect(stories.eventLog(story.id)).toEqual(events); expect(stories.run(a.id)).toEqual(run)
      const other = stories.create('另一个会话', profile())
      const b = stories.enqueue({ storyId: other.id, requestId: 'b', inputHash: 'b', turnId: 'b' }, () => {}).run
      stories.setRunStatus(b.id, 'running')
      expect(() => database.sqlite.prepare("UPDATE runs SET story_id = ? WHERE id = ?").run(story.id, b.id)).toThrow('UNIQUE constraint failed: runs.story_id')
      expect(stories.recoverInterrupted()).toBe(2)
      expect(stories.run(a.id)).toMatchObject({ status: 'interrupted', draft: '升级前的草稿' })
    } finally { database.close() }
  })

  it('preserves drafts and cancels pending questions after process interruption', () => {
    const { database, stories, filename } = setup()
    const story = stories.create('重启', profile())
    const run = stories.enqueue({ storyId: story.id, requestId: 'a', inputHash: 'a', turnId: 'a' }, () => {}).run
    stories.setRunStatus(run.id, 'running')
    stories.saveDraft(run.id, '尚未完成的正文')
    stories.append(story.id, { type: 'question.asked', data: { id: 'q-a', runId: run.id, questions: [{ id: 'direction', question: '走哪一条路？', options: [{ label: '左' }, { label: '右' }], multiSelect: false }], status: 'pending' } })
    stories.setRunStatus(run.id, 'waiting_user')
    database.close()
    const reopened = new AppDatabase(filename)
    try {
      const repository = new StoryRepository(reopened)
      expect(repository.recoverInterrupted()).toBe(1)
      expect(repository.recoverInterrupted()).toBe(0)
      expect(repository.run(run.id)).toMatchObject({ status: 'interrupted', draft: '尚未完成的正文' })
      expect(repository.snapshot(story.id).questions[0]?.status).toBe('cancelled')
      expect(repository.snapshot(story.id).messages).toEqual([])
    } finally { reopened.close() }
  })
})
