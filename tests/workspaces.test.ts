import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createServer } from '../apps/server/src/server.ts'
import { createToolServer } from '../apps/tools/src/server.ts'
import { ToolClient } from '../apps/server/src/runtime/tool-client.ts'
import { SidebarService } from '../apps/server/src/services/sidebar-service.ts'
import { message } from './helpers.ts'

const clean: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close() })
const signal = () => new AbortController().signal
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rp-workspaces-'))
  clean.push(() => rm(root, { recursive: true, force: true }))
  const roots = { workspaces: join(root, 'workspaces'), inputs: join(root, 'data/inputs'), skills: join(root, 'skills') }
  await Promise.all(Object.values(roots).map(path => mkdir(path, { recursive: true })))
  const token = 'synthetic-workspace-token-0123456789abcdef', toolServer = createToolServer({ token, roots })
  clean.push(() => toolServer.app.close())
  const toolUrl = await toolServer.app.listen({ host: '127.0.0.1', port: 0 })
  const config = { dataDirectory: join(root, 'data'), publicOrigin: 'http://workspace.test', sessionKey: randomBytes(32), models: [], defaultMain: null, tools: { url: toolUrl, token }, skillRoots: [] }
  const server = await createServer(config)
  clean.push(() => server.app.close())
  await server.auth.setPassword('workspace-test-password')
  const login = await server.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config.publicOrigin }, payload: { password: 'workspace-test-password' } })
  const cookie = String(login.headers['set-cookie']).split(';')[0]!
  const call = async (url: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', payload?: object) => {
    const response = await server.app.inject({ method, url, headers: { cookie, origin: config.publicOrigin }, ...(payload ? { payload } : {}) })
    return { status: response.statusCode, body: response.json() }
  }
  return { ...server, root, roots, token, toolUrl, toolServer, config, call }
}

it('creates managed directories from names alone, rejects client paths, and keeps files stable on rename', async () => {
  const x = await setup()
  expect((await x.app.inject('/api/workspaces')).statusCode).toBe(401)
  const first = await x.call('/api/workspaces', 'POST', { name: ' 灯塔 ' })
  expect(first.status).toBe(201)
  const { id, directory } = first.body.workspace
  expect(first.body.workspace).toMatchObject({ name: '灯塔', directory: `workspace-${id}`, access: 'read-write' })
  expect(await readdir(join(x.roots.workspaces, directory))).toEqual([])
  await writeFile(join(x.roots.workspaces, directory, 'note.txt'), '原始文件')
  expect((await x.call('/api/workspaces/directories')).status).toBe(404)
  for (const extra of [{ directory: '/etc' }, { directory: '../outside' }, { directory }, { create: false }, { create: true }]) {
    expect((await x.call('/api/workspaces', 'POST', { name: '无效请求', access: 'read-only', ...extra })).status).toBe(400)
  }
  for (const name of ['', '  ', 'x'.repeat(121), 'a\nb']) expect((await x.call('/api/workspaces', 'POST', { name, access: 'read-write' })).status).toBe(400)
  expect(x.workspaces.list()).toHaveLength(1)
  const updated = await x.call('/api/workspaces/' + id, 'PUT', { expectedRevision: 1, name: '灯塔档案', access: 'read-only' })
  expect(updated.body.workspace).toMatchObject({ name: '灯塔档案', directory, revision: 2, access: 'read-only' })
  expect((await x.call('/api/workspaces/' + id, 'PUT', { expectedRevision: 1, name: '过期修改', access: 'read-write' })).status).toBe(409)
  expect(await readFile(join(x.roots.workspaces, directory, 'note.txt'), 'utf8')).toBe('原始文件')
})

it('gives concurrent same-name workspaces separate directories and never turns a display name into a path', async () => {
  const x = await setup()
  const results = await Promise.all(['同名', '同名', '../../灯塔/草稿'].map(name => x.call('/api/workspaces', 'POST', { name, access: 'read-only' })))
  expect(results.map(result => result.status)).toEqual([201, 201, 201])
  const directories = results.map(result => result.body.workspace.directory)
  expect(new Set(directories).size).toBe(3)
  expect((await readdir(x.roots.workspaces)).sort()).toEqual(directories.sort())
  for (const result of results) {
    expect(result.body.workspace.directory).toBe(`workspace-${result.body.workspace.id}`)
    expect(await readdir(join(x.roots.workspaces, result.body.workspace.directory))).toEqual([])
  }
})

it('keeps tool directory creation exclusive and rejects traversal, symlink parents, and obsolete linking requests', async () => {
  const x = await setup(), filesystem = x.toolServer.runner.filesystem
  await filesystem.prepareDirectory('existing')
  await writeFile(join(x.roots.workspaces, 'existing/keep.txt'), 'preserve')
  await expect(filesystem.prepareDirectory('existing')).rejects.toMatchObject({ code: 'WORKSPACE_DIRECTORY_EXISTS' })
  for (const directory of ['/etc', '../outside', 'a/../../b', 'a\\b', 'a//b']) await expect(filesystem.prepareDirectory(directory)).rejects.toMatchObject({ code: 'INVALID_WORKSPACE_DIRECTORY' })
  await symlink(x.roots.inputs, join(x.roots.workspaces, 'escape'))
  await symlink(join(x.roots.workspaces, 'existing'), join(x.roots.workspaces, 'alias'))
  for (const directory of ['escape/new', 'alias/new']) await expect(filesystem.prepareDirectory(directory)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
  const headers = { authorization: 'Bearer ' + x.token }
  expect((await x.toolServer.app.inject({ method: 'POST', url: '/v1/workspaces/prepare', headers, payload: { directory: 'existing', create: false } })).statusCode).toBe(400)
  expect((await x.toolServer.app.inject({ url: '/v1/workspaces/directories', headers })).statusCode).toBe(404)
  expect(await readFile(join(x.roots.workspaces, 'existing/keep.txt'), 'utf8')).toBe('preserve')
})

it('reports tool creation failure without saving a workspace record', async () => {
  const x = await setup()
  await x.toolServer.app.close()
  expect((await x.call('/api/workspaces', 'POST', { name: '暂时不可用', access: 'read-write' })).status).toBe(500)
  expect(x.workspaces.list()).toEqual([])
  expect(await readdir(x.roots.workspaces)).toEqual([])
})

it('retires the global default while preserving existing readonly directories, files and bindings on upgrade', async () => {
  const x = await setup(), id = randomUUID(), directory = 'legacy/lighthouse', now = new Date().toISOString()
  await mkdir(join(x.roots.workspaces, directory), { recursive: true })
  await writeFile(join(x.roots.workspaces, directory, 'keep.txt'), '旧工作区文件')
  // This row represents an existing installation, not a public path-selection API.
  x.stories.database.sqlite.prepare('INSERT INTO workspaces VALUES (?,?,?,?,1,?,?)').run(id, '旧工作区', directory, 'read-only', now, now)
  const story = x.service.create('已有会话')
  x.stories.append(story.id, { type: 'workspace.changed', data: { workspaceId: id, directory, access: 'read-only', createIfMissing: false } })
  expect(x.workspaces.update(id, 1, { name: '旧工作区改名', access: 'read-only' })).toMatchObject({ directory, revision: 2 })
  x.assets.setSetting('app.workspaces', { version: 1, revision: 3, defaultAccess: 'read-only' })
  x.stories.database.sqlite.exec('DELETE FROM __rp_migrations WHERE version = 5')
  await x.app.close()
  const restarted = await createServer(x.config)
  try {
    expect(restarted.workspaces.get(id)).toMatchObject({ name: '旧工作区改名', directory, revision: 2 })
    expect(restarted.workspaces.forStory(story.id)).toEqual({ workspaceId: id, directory, access: 'read-only', createIfMissing: false })
    expect(await restarted.client.execute(story.id, { kind: 'read', path: 'keep.txt' }, { signal: signal() })).toMatchObject({ text: '旧工作区文件' })
    expect(restarted.stories.database.sqlite.prepare("SELECT value FROM settings WHERE key = 'app.workspaces'").get()).toBeUndefined()
    const created = restarted.service.create('新建独立会话')
    expect(restarted.workspaces.forStory(created.id).access).toBe('read-write')
    expect(await restarted.workspaces.create({ name: '新建工作区' })).toMatchObject({ access: 'read-write' })
  } finally { await restarted.app.close() }
})

it('shares files with a workspace and fork, resets Bash on reassociation, and retains all files, sessions and permissions on removal and restart', async () => {
  const x = await setup()
  const a = await x.workspaces.create({ name: '甲', access: 'read-write' })
  const b = await x.workspaces.create({ name: '乙', access: 'read-write' })
  const created = await x.call('/api/stories', 'POST', { title: '原会话', workspaceId: a.id })
  expect(created.status).toBe(201)
  const id = created.body.story.id
  await x.client.execute(id, { kind: 'bash', command: 'export RP_ASSOCIATION_CHECK=old; printf retained > shared.txt' }, { signal: signal() })
  const prose = message('assistant', '原始正文')
  x.stories.append(id, { type: 'message.added', data: { message: prose } })
  const fork = x.service.fork(id, x.stories.latestSequence(id), prose.id)
  expect(x.workspaces.forStory(fork.id).workspaceId).toBe(a.id)
  expect(await x.client.execute(fork.id, { kind: 'read', path: 'shared.txt' }, { signal: signal() })).toMatchObject({ text: 'retained' })
  const bindingRevision = x.workspaces.storyInfo(id).revision
  x.stories.append(id, { type: 'story.renamed', data: { title: '无关的会话更新' } })
  x.workspaces.associate(id, bindingRevision, b.id)
  expect(() => x.workspaces.associate(id, bindingRevision, a.id)).toThrow('会话工作区已更新')
  expect(await x.client.execute(id, { kind: 'bash', command: 'printf "%s" "${RP_ASSOCIATION_CHECK-new}"' }, { signal: signal() })).toMatchObject({ output: 'new', shellState: 'new' })
  expect(x.workspaces.forStory(fork.id).directory).toBe(a.directory)
  x.workspaces.update(a.id, a.revision, { name: '甲只读', access: 'read-only' })
  expect(await x.client.execute(fork.id, { kind: 'read', path: 'shared.txt' }, { signal: signal() })).toMatchObject({ text: 'retained' })
  for (const command of [{ kind: 'bash' as const, command: 'rm shared.txt' }, { kind: 'edit' as const, command: 'write' as const, path: 'shared.txt', fileText: 'wrong' }]) {
    await expect(x.client.execute(fork.id, command, { signal: signal() })).rejects.toMatchObject({ code: 'WORKSPACE_READ_ONLY' })
  }
  const removed = x.workspaces.remove(a.id, 2)
  expect(removed).toEqual({ removed: true, filesRetained: true, sessionsRetained: 1 })
  expect(x.workspaces.forStory(fork.id)).toMatchObject({ workspaceId: null, directory: a.directory, access: 'read-only' })
  const before = x.stories.snapshot(fork.id)
  await x.app.close()
  const restarted = await createServer(x.config)
  try {
    expect(restarted.stories.snapshot(fork.id)).toEqual(before)
    expect(restarted.workspaces.forStory(fork.id)).toEqual({ workspaceId: null, directory: a.directory, access: 'read-only', createIfMissing: false })
    expect(await restarted.client.execute(fork.id, { kind: 'read', path: 'shared.txt' }, { signal: signal() })).toMatchObject({ text: 'retained' })
  } finally { await restarted.app.close() }
})

it('guards queued members and ungrouped shared directories against permission changes, stale revisions, and partial creation', async () => {
  const x = await setup(), story = x.service.create('独立目录')
  const workspace = await x.workspaces.create({ name: '共享目录', access: 'read-only' })
  x.workspaces.associate(story.id, x.workspaces.storyInfo(story.id).revision, workspace.id)
  expect(x.workspaces.forStory(story.id).workspaceId).toBe(workspace.id)
  x.workspaces.associate(story.id, x.workspaces.storyInfo(story.id).revision, null)
  expect(() => x.workspaces.associate(story.id, x.workspaces.storyInfo(story.id).revision, null, 'read-write')).toThrow('共享工作区')
  const pending = x.stories.enqueue({ storyId: story.id, requestId: randomUUID(), inputHash: 'hash', turnId: randomUUID() }, () => {}).run
  expect(() => x.workspaces.update(workspace.id, 1, { name: '改权限', access: 'read-write' })).toThrow('当前回复')
  expect(() => x.workspaces.remove(workspace.id, 1)).toThrow('当前回复')
  expect(() => x.workspaces.associate(story.id, x.workspaces.storyInfo(story.id).revision, workspace.id)).toThrow('当前回复')
  expect(x.workspaces.update(workspace.id, 1, { name: '运行中重命名', access: 'read-only' }).revision).toBe(2)
  x.stories.setRunStatus(pending.id, 'cancelled')
  x.workspaces.update(workspace.id, 2, { name: '可写', access: 'read-write' })
  expect(x.workspaces.forStory(story.id).access).toBe('read-write')
  const before = x.stories.list().length
  expect((await x.call('/api/stories', 'POST', { title: '不能半创建', workspaceId: randomUUID() })).status).toBe(404)
  expect(x.stories.list()).toHaveLength(before)
})

it('enforces readonly inside the tool HTTP service even for a direct protocol dispatch and rejects missing policy', async () => {
  const x = await setup(), id = randomUUID()
  const client = new ToolClient(x.toolUrl, x.token, fetch, () => ({ directory: id, access: 'read-only', createIfMissing: true }))
  expect(await client.execute(id, { kind: 'list' }, { signal: signal() })).toMatchObject({ entries: [] })
  await expect(client.execute(id, { kind: 'bash', command: 'touch forbidden.txt' }, { signal: signal() })).rejects.toMatchObject({ code: 'WORKSPACE_READ_ONLY' })
  const response = await fetch(x.toolUrl + '/v1/execute', { method: 'POST', headers: { authorization: 'Bearer ' + x.token, 'content-type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), storyId: id, workspace: { directory: id }, command: { kind: 'bash', command: 'touch forbidden.txt' } }) })
  expect(response.status).toBe(400)
  expect(await client.execute(id, { kind: 'list' }, { signal: signal() })).toMatchObject({ entries: [] })
})

it('migrates existing sidebar settings and saves grouping with separate manual workspace order', async () => {
  const x = await setup(), a = await x.workspaces.create({ name: '甲', access: 'read-write' }), b = await x.workspaces.create({ name: '乙', access: 'read-only' })
  const story = x.service.create('会话'), sidebar = new SidebarService(x.assets, x.stories)
  x.assets.setSetting('app.sidebar', { version: 1, revision: 7, sort: 'manual', order: [story.id] })
  expect(sidebar.snapshot()).toEqual({ version: 3, revision: 7, sort: 'manual', order: [story.id], view: 'single', workspaceOrder: [], pinnedStoryIds: [] })
  expect((await x.call('/api/settings/sidebar', 'PUT', { expectedRevision: 7, sort: 'manual', order: [story.id], view: 'workspaces', workspaceOrder: [b.id, a.id], pinnedStoryIds: [] })).status).toBe(200)
  expect(sidebar.snapshot()).toMatchObject({ view: 'workspaces', workspaceOrder: [b.id, a.id], revision: 8 })
  expect(() => sidebar.update(8, 'manual', [], 'workspaces', [randomUUID()], [])).toThrow('工作区已不存在')
})
