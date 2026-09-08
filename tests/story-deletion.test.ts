import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { StoryRepository } from '../apps/server/src/storage/story-repository.ts'
import { AssetRepository } from '../apps/server/src/storage/asset-repository.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { StoryDeletionService } from '../apps/server/src/services/story-deletion-service.ts'
import { SidebarService } from '../apps/server/src/services/sidebar-service.ts'
import { InputQueueService } from '../apps/server/src/services/input-queue-service.ts'
import { fixture, message, profile } from './helpers.ts'

const clean: (() => void)[] = []
afterEach(() => { for (const close of clean.splice(0)) close() })
function setup() {
  const x = fixture(); clean.push(x.close)
  const service = new StoryService(x.stories, x.assets, x.files), sidebar = new SidebarService(x.assets, x.stories), background = new Set<string>()
  const deletion = new StoryDeletionService(x.stories, sidebar, id => background.has(id))
  return { ...x, service, sidebar, background, deletion }
}

describe('permanent conversation deletion', () => {
  it('removes owned records and pins while preserving other stories, shared resources and attachments across backup/reopen', async () => {
    const x = setup(), first = x.service.create('待删除'), other = x.service.create('保留')
    const attachment = x.files.save(Buffer.from('shared fixture'), 'shared.txt', 'text/plain')
    const run = x.service.send(first.id, 'run', [{ text: '待删除的消息', attachmentIds: [attachment.id] }]).run
    x.stories.setRunStatus(run.id, 'running')
    const inputs = new InputQueueService(x.service)
    const unregister = inputs.register(run.id, { notify() {}, validate() {} })
    const pending = inputs.submit(first.id, 'pending', [{ text: '待发消息', attachmentIds: [] }], 'steer', run.id)
    unregister()
    x.stories.setRunStatus(run.id, 'cancelled')
    x.sidebar.update(1, 'manual', [first.id, other.id], 'single', [], [first.id, other.id])
    const assets = x.database.sqlite.prepare('SELECT * FROM assets ORDER BY id').all()
    x.deletion.delete(first.id, x.stories.snapshot(first.id).revision)
    for (const table of ['events', 'runs', 'pending_inputs']) expect(x.database.sqlite.prepare(`SELECT * FROM ${table} WHERE story_id = ?`).all(first.id)).toEqual([])
    expect(() => inputs.get(pending.item.id)).toThrow('已不存在')
    expect(() => x.stories.run(run.id)).toThrow('已不存在')
    expect(x.stories.snapshot(other.id)).toEqual(other)
    expect(x.files.read(attachment.id).bytes.toString()).toBe('shared fixture')
    expect(x.database.sqlite.prepare('SELECT * FROM assets ORDER BY id').all()).toEqual(assets)
    expect(x.sidebar.snapshot()).toMatchObject({ revision: 3, order: [other.id], pinnedStoryIds: [other.id] })
    expect(x.database.sqlite.pragma('foreign_key_check')).toEqual([])
    const backup = join(x.directory, 'deleted-backup.sqlite')
    await x.database.sqlite.backup(backup)
    for (const filename of [backup, x.filename]) {
      if (filename === x.filename) x.database.close()
      const restored = new AppDatabase(filename)
      try {
        const stories = new StoryRepository(restored)
        expect(stories.exists(first.id)).toBe(false)
        expect(stories.snapshot(other.id)).toEqual(other)
        expect(restored.sqlite.prepare('SELECT id FROM deleted_stories').all()).toEqual([{ id: first.id }])
        expect(new SidebarService(new AssetRepository(restored), stories).snapshot().pinnedStoryIds).toEqual([other.id])
        expect(() => stories.create('旧请求重放', profile(), undefined, undefined, { id: first.id, key: 'replay' })).toThrow('已删除')
      } finally { restored.close() }
    }
  })

  it('preserves new and old descendants without rewriting their story facts or losing their inherited workspace', () => {
    const x = setup(), root = x.stories.create('原会话', profile()), opening = message('assistant', '分支保留的正文')
    x.stories.append(root.id, { type: 'message.added', data: { message: opening } })
    const branch = x.service.fork(root.id, x.stories.snapshot(root.id).revision, opening.id)
    const child = x.service.fork(branch.id, branch.revision, opening.id)
    const modern = x.service.fork(root.id, x.stories.snapshot(root.id).revision, opening.id)
    x.database.sqlite.prepare("DELETE FROM events WHERE story_id IN (?, ?) AND type = 'workspace.changed'").run(branch.id, child.id)
    const before = [branch, child, modern].map(item => ({ story: x.stories.snapshot(item.id), binding: x.stories.workspaceBinding(item.id) }))
    x.deletion.delete(root.id, x.stories.snapshot(root.id).revision)
    for (const item of before) {
      expect(x.stories.workspaceBinding(item.story.id)).toEqual(item.binding)
      const after = x.stories.snapshot(item.story.id)
      expect({ ...after, revision: item.story.revision, updatedAt: item.story.updatedAt }).toEqual(item.story)
    }
    x.deletion.delete(branch.id, x.stories.snapshot(branch.id).revision)
    expect(x.stories.workspaceBinding(child.id)).toEqual(before[1]!.binding)
    expect(x.stories.snapshot(child.id).messages[0]?.text).toBe(opening.text)
  })

  it('rejects stale confirmation, active generations, manual summaries and background jobs without partial deletion', () => {
    const x = setup(), story = x.service.create('并发保护')
    x.service.rename(story.id, story.revision, '已改名')
    expect(() => x.deletion.delete(story.id, story.revision)).toThrow('已经更新')
    const run = x.service.send(story.id, 'active', [{ text: '继续', attachmentIds: [] }]).run
    for (const status of ['queued', 'running', 'waiting_user'] as const) {
      if (status !== 'queued') x.stories.setRunStatus(run.id, status)
      expect(() => x.deletion.delete(story.id, x.stories.snapshot(story.id).revision)).toThrow('停止生成')
    }
    x.stories.setRunStatus(run.id, 'cancelled')
    x.background.add(story.id)
    expect(() => x.deletion.delete(story.id, x.stories.snapshot(story.id).revision)).toThrow('后台任务')
    x.background.clear()
    x.stories.append(story.id, { type: 'maintenance.status', data: { id: 'summary', kind: 'summary', status: 'running', trigger: 'manual' } })
    expect(() => x.deletion.delete(story.id, x.stories.snapshot(story.id).revision)).toThrow('停止总结')
    expect(x.stories.snapshot(story.id).messages.length).toBeGreaterThan(0)
    expect(x.database.sqlite.prepare('SELECT * FROM deleted_stories').all()).toEqual([])
  })

  it('rolls back branch binding, cascade and sidebar changes if any deletion step fails', () => {
    const x = setup(), root = x.stories.create('原会话', profile()), reply = message('assistant', '正文')
    x.stories.append(root.id, { type: 'message.added', data: { message: reply } })
    const child = x.service.fork(root.id, x.stories.snapshot(root.id).revision, reply.id)
    x.database.sqlite.prepare("DELETE FROM events WHERE story_id = ? AND type = 'workspace.changed'").run(child.id)
    x.sidebar.pin(1, root.id, true)
    const rootBefore = x.stories.snapshot(root.id), childBefore = x.stories.snapshot(child.id)
    x.database.sqlite.exec("CREATE TRIGGER fail_deletion BEFORE INSERT ON deleted_stories BEGIN SELECT RAISE(ABORT, 'synthetic deletion failure'); END")
    expect(() => x.deletion.delete(root.id, rootBefore.revision)).toThrow('synthetic deletion failure')
    expect(x.stories.snapshot(root.id)).toEqual(rootBefore)
    expect(x.stories.snapshot(child.id)).toEqual(childBefore)
    expect(x.sidebar.snapshot().pinnedStoryIds).toEqual([root.id])
    expect(x.database.sqlite.prepare('SELECT * FROM deleted_stories').all()).toEqual([])
  })
})
