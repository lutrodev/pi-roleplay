import Fastify from 'fastify'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture, message, profile } from './helpers.ts'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { AssetRepository } from '../apps/server/src/storage/asset-repository.ts'
import { StoryRepository } from '../apps/server/src/storage/story-repository.ts'
import { SidebarService } from '../apps/server/src/services/sidebar-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { AuthService } from '../apps/server/src/services/auth-service.ts'
import { searchStories } from '../apps/server/src/services/story-search.ts'
import { registerAuthentication } from '../apps/server/src/http/auth.ts'
import { registerErrors } from '../apps/server/src/http/errors.ts'
import { registerSidebar } from '../apps/server/src/http/sidebar.ts'
import { sidebarSections, visibleStoryCount, workspaceGroups } from '../apps/web/src/lib/sidebar.ts'
import type { StoryListItem } from '../apps/web/src/lib/story-list.ts'
import type { WorkspaceRecord } from '../packages/rp-core/src/workspace.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })
function setup() { const x = fixture(); cleanup.push(() => x.close()); return { ...x, sidebar: new SidebarService(x.assets, x.stories), service: new StoryService(x.stories, x.assets, x.files) } }

it('defaults to recent conversations and upgrades both saved layouts without discarding manual choices', () => {
  const x = setup(), story = x.service.create('旧会话')
  expect(x.sidebar.snapshot()).toMatchObject({ version: 3, revision: 1, view: 'single', sort: 'recent', pinnedStoryIds: [] })
  for (const version of [1, 2]) {
    x.assets.setSetting('app.sidebar', { version, revision: 7, sort: 'manual', order: [story.id], ...(version === 2 ? { view: 'workspaces', workspaceOrder: [] } : {}) })
    const migrated = x.sidebar.snapshot()
    expect(migrated).toEqual({ version: 3, revision: 7, sort: 'manual', order: [story.id], view: version === 1 ? 'single' : 'workspaces', workspaceOrder: [], pinnedStoryIds: [] })
    expect(x.assets.getSetting('app.sidebar')).toEqual(migrated)
  }
})

it('pins during a run without changing facts, archive positions, file bindings or sort order', () => {
  const x = setup(), a = x.service.create('甲'), b = x.service.create('乙')
  x.stories.append(a.id, { type: 'workspace.changed', data: { workspaceId: null, directory: 'shared-readonly', access: 'read-only', createIfMissing: false } })
  const run = x.stories.enqueue({ storyId: a.id, requestId: randomUUID(), inputHash: 'hash', turnId: randomUUID() }, () => {}).run
  const facts = x.stories.eventLog(a.id), snapshot = x.stories.snapshot(a.id)
  const sorted = x.sidebar.update(1, 'manual', [b.id, a.id], 'single', [], [])
  const first = x.sidebar.pin(sorted.revision, a.id, true), both = x.sidebar.pin(first.revision, b.id, true)
  expect(both).toMatchObject({ order: [b.id, a.id], pinnedStoryIds: [a.id, b.id] })
  expect(x.stories.eventLog(a.id)).toEqual(facts); expect(x.stories.snapshot(a.id)).toEqual(snapshot)
  x.stories.setRunStatus(run.id, 'cancelled')
  x.service.archive(a.id, x.stories.snapshot(a.id).revision, true)
  expect(x.sidebar.snapshot().pinnedStoryIds).toEqual([a.id, b.id])
  expect(sidebarSections(searchStories(x.stories, false), both).pinned.map(item => item.id)).toEqual([b.id])
  x.service.archive(a.id, x.stories.snapshot(a.id).revision, false)
  expect(sidebarSections(searchStories(x.stories, false), both).pinned.map(item => item.id)).toEqual([a.id, b.id])
  expect(x.sidebar.pin(both.revision, a.id, false).pinnedStoryIds).toEqual([b.id])
})

it('survives database backup and recovery and prunes only deleted identities', async () => {
  const x = setup(), story = x.service.create('恢复后仍置顶'), deleted = x.service.create('已删除'), workspace = randomUUID()
  x.database.sqlite.prepare('INSERT INTO workspaces(id,name,directory,access,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(workspace, '已移除目录', 'removed', 'read-only', 1, '2026-09-06', '2026-09-06')
  const saved = x.sidebar.update(1, 'manual', [story.id, deleted.id], 'workspaces', [workspace], [story.id, deleted.id])
  const backup = join(x.directory, 'recovery.sqlite'); await x.database.sqlite.backup(backup)
  const recovered = new AppDatabase(backup)
  try {
    const sidebar = new SidebarService(new AssetRepository(recovered), new StoryRepository(recovered))
    expect(sidebar.snapshot()).toEqual(saved)
    recovered.sqlite.prepare('DELETE FROM stories WHERE id=?').run(deleted.id)
    recovered.sqlite.prepare('DELETE FROM workspaces WHERE id=?').run(workspace)
    expect(sidebar.snapshot()).toEqual({ ...saved, revision: 3, order: [story.id], pinnedStoryIds: [story.id], workspaceOrder: [] })
    expect(sidebar.pin(3, story.id, false).pinnedStoryIds).toEqual([])
  } finally { recovered.close() }
})

it('rejects stale and invalid edits atomically and reports corrupt saved pins', () => {
  const x = setup(), a = x.service.create('甲'), b = x.service.create('乙'), saved = x.sidebar.pin(1, a.id, true)
  expect(() => x.sidebar.pin(1, b.id, true)).toThrow('已更新')
  expect(() => x.sidebar.pin(saved.revision, randomUUID(), true)).toThrow()
  expect(() => x.sidebar.update(saved.revision, 'recent', [], 'single', [], [a.id, a.id])).toThrow('置顶会话列表不正确')
  expect(x.sidebar.snapshot()).toEqual(saved)
  x.assets.setSetting('app.sidebar', { ...saved, pinnedStoryIds: [123] })
  expect(() => x.sidebar.snapshot()).toThrow('置顶会话设置损坏')
})

it('authenticates the pin API and refuses cross-origin, malformed and conflicting updates', async () => {
  const x = setup(), story = x.service.create('接口测试'), app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } }), auth = new AuthService(x.assets)
  cleanup.push(() => app.close()); registerErrors(app)
  const origin = 'https://sidebar.test', password = 'synthetic-sidebar-password', url = '/api/settings/sidebar/pins/' + story.id
  await registerAuthentication(app, auth, { publicOrigin: origin, sessionKey: randomBytes(32) }); registerSidebar(app, x.sidebar); await auth.setPassword(password)
  expect((await app.inject('/api/settings/sidebar')).statusCode).toBe(401)
  expect((await app.inject({ method: 'PATCH', url, headers: { origin }, payload: { expectedRevision: 1, pinned: true } })).statusCode).toBe(401)
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password } })
  const headers = { origin, cookie: String(login.headers['set-cookie']).split(';')[0]! }, payload = { expectedRevision: 1, pinned: true }
  expect((await app.inject({ method: 'PATCH', url, headers: { ...headers, origin: 'https://outside.test' }, payload })).statusCode).toBe(403)
  expect((await app.inject({ method: 'PATCH', url, headers, payload: { ...payload, workspaceId: randomUUID() } })).statusCode).toBe(400)
  expect((await app.inject({ method: 'PATCH', url, headers, payload: { ...payload, pinned: 'true' } })).statusCode).toBe(400)
  expect((await app.inject({ method: 'PATCH', url, headers, payload })).json()).toMatchObject({ revision: 2, pinnedStoryIds: [story.id] })
  expect((await app.inject({ method: 'PATCH', url, headers, payload })).statusCode).toBe(409)
})

it('keeps activity order stable through streaming drafts and exposes the actual run status', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
  const x = setup(), a = x.stories.create('早先开始生成', profile())
  const run = x.stories.enqueue({ storyId: a.id, requestId: randomUUID(), inputHash: 'hash', turnId: randomUUID() }, () => {}).run
  x.stories.setRunStatus(run.id, 'running')
  vi.setSystemTime(new Date('2026-09-02T00:00:00Z')); const b = x.stories.create('后来打开', profile())
  vi.setSystemTime(new Date('2026-09-03T00:00:00Z'))
  x.stories.append(a.id, { type: 'run.draft', data: { runId: run.id, text: '草稿内容', replace: false } })
  x.stories.append(a.id, { type: 'model.message', data: { runId: run.id, ownerMessageId: 'owner', role: 'assistant', message: { text: '诊断信息' } } })
  const list = searchStories(x.stories, false)
  expect(list.map(item => item.id)).toEqual([b.id, a.id]); expect(list[1]).toMatchObject({ status: 'running', updatedAt: '2026-09-01T00:00:00.000Z' })
  expect(searchStories(x.stories, false, '草稿内容')).toEqual([])
  x.stories.append(a.id, { type: 'message.added', data: { message: message('user', '新的用户输入') } })
  expect(searchStories(x.stories, false).map(item => item.id)).toEqual([a.id, b.id])
})

it('separates pins from recent rows, hides empty workspaces, and renders a selected row beyond the first page', () => {
  const settings = setup().sidebar.snapshot()
  const row = (id: string, workspaceId?: string): StoryListItem => ({ id, title: id, workspaceId, archived: false, createdAt: '2026-09-01', updatedAt: '2026-09-01' })
  const stories = [row('pin', 'a'), row('b', 'b'), row('independent'), row('archive')]; stories[3]!.archived = true
  const sections = sidebarSections(stories, { ...settings, pinnedStoryIds: ['pin', 'archive'] })
  expect(sections.pinned.map(item => item.id)).toEqual(['pin'])
  expect(sections.regular.map(item => item.id)).toEqual(['b', 'independent'])
  const workspaces: WorkspaceRecord[] = ['a', 'b', 'empty'].map(id => ({ id, name: id, directory: id, access: 'read-only', revision: 1, createdAt: '', updatedAt: '' }))
  expect(workspaceGroups(sections.regular, workspaces, settings).map(group => group.id)).toEqual(['b', ''])
  expect(workspaceGroups([row('new-in-another-window', 'new-workspace')], workspaces, settings)).toEqual([{ id: 'new-workspace', name: '', stories: [row('new-in-another-window', 'new-workspace')] }])
  const many = Array.from({ length: 100 }, (_, index) => row(String(index)))
  expect(visibleStoryCount(many, 40, '75')).toBe(76)
  expect(visibleStoryCount(many, 40, 'missing')).toBe(40)
  expect(sidebarSections(many.slice(0, 3), { ...settings, sort: 'manual', order: ['1', '0'] }).regular.map(item => item.id)).toEqual(['2', '1', '0'])
})
