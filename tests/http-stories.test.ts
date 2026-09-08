import Fastify, { type InjectOptions } from 'fastify'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAuthentication } from '../apps/server/src/http/auth.ts'
import { registerErrors } from '../apps/server/src/http/errors.ts'
import { WorkspaceService } from '../apps/server/src/services/workspace-service.ts'
import { ToolClient } from '../apps/server/src/runtime/tool-client.ts'
import { registerStoryRoutes } from '../apps/server/src/http/stories.ts'
import { AuthService } from '../apps/server/src/services/auth-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { StoryDeletionService } from '../apps/server/src/services/story-deletion-service.ts'
import { SidebarService } from '../apps/server/src/services/sidebar-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { QuestionService } from '../apps/server/src/services/question-service.ts'
import { searchStories } from '../apps/server/src/services/story-search.ts'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import { fixture, recordModelReply } from './helpers.ts'

const close: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of close.splice(0)) await cleanup() })
const origin = 'http://rp.test'
async function setup(mode: 'commit' | 'wait' | 'ask' = 'commit') {
  const x = fixture(), auth = new AuthService(x.assets), questions = new QuestionService(x.stories), turns = new TurnService(x.stories)
  const service = new StoryService(x.stories, x.assets, x.files), faults: unknown[] = []
  const queue = new RunQueue(x.stories, async (id, signal) => {
    const run = x.stories.run(id)
    if (mode === 'wait') return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    if (mode === 'ask') await questions.ask(id, 'ask-route', [{ id: 'direction', question: '走向哪里？', options: [{ label: '海边' }, { label: '山中' }], multiSelect: false }], signal)
    const context = x.stories.append(run.storyId, { type: 'context.built', data: { runId: id, writerPrompt: '冻结的写作资料', parentPrompt: '编排资料', sources: [], model: { provider: 'test', model: 'test' } } })
    turns.recordWriter(id, 'writer-route', context.seq, '沿着海岸继续前行。')
    const owner = randomUUID()
    recordModelReply(x.stories, run, owner, '沿着海岸继续前行。')
    await turns.commit(id, owner, '沿着海岸继续前行。', { runSummary: '沿岸前行。' })
  }, error => faults.push(error))
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } })
  await registerAuthentication(app, auth, { publicOrigin: origin, sessionKey: randomBytes(32) })
  registerErrors(app); registerStoryRoutes(app, service, queue, questions, new WorkspaceService(x.stories, new ToolClient('http://tools.test', 'synthetic-tool-token-0123456789abcdef')), new StoryDeletionService(x.stories, new SidebarService(x.assets, x.stories), () => false))
  close.push(async () => { await queue.close(); await app.close(); x.close(); expect(faults).toEqual([]) })
  await auth.setPassword('http-route-test-password')
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password: 'http-route-test-password' } })
  const cookie = String(login.headers['set-cookie']).split(';')[0]!
  const call = (options: InjectOptions) => app.inject({ ...options, headers: { origin, cookie, ...options.headers } })
  const created = await call({ method: 'POST', url: '/api/stories', payload: { title: '接口故事', profile: { runtime: { executionMode: mode === 'ask' ? 'agent' : 'chat' } } } })
  expect(created.statusCode).toBe(201)
  const storyId = created.json().story.id as string, base = `/api/stories/${storyId}`
  return { ...x, app, queue, call, base, storyId, service }
}

describe('story and run HTTP commands', () => {
  it('requires authentication, same-origin confirmation and the current revision to delete an archived story', async () => {
    const x = await setup(), revision = x.stories.snapshot(x.storyId).revision
    expect((await x.app.inject({ method: 'DELETE', url: x.base, headers: { origin }, payload: { expectedRevision: revision } })).statusCode).toBe(401)
    expect((await x.call({ method: 'DELETE', url: x.base, headers: { origin: 'http://elsewhere.test' }, payload: { expectedRevision: revision } })).statusCode).toBe(403)
    expect((await x.call({ method: 'DELETE', url: x.base, payload: {} })).statusCode).toBe(400)
    x.service.archive(x.storyId, revision, true)
    const conflict = await x.call({ method: 'DELETE', url: x.base, payload: { expectedRevision: revision } })
    expect(conflict.statusCode).toBe(409); expect(conflict.json().error.code).toBe('REVISION_CONFLICT')
    const body = { expectedRevision: x.stories.snapshot(x.storyId).revision }
    expect((await x.call({ method: 'DELETE', url: x.base, payload: body })).statusCode).toBe(204)
    expect((await x.call({ method: 'DELETE', url: x.base, payload: body })).statusCode).toBe(204)
    expect((await x.call({ url: x.base })).statusCode).toBe(404)
    expect((await x.call({ url: '/api/stories?archived=true' })).json().stories).toEqual([])
    expect((await x.call({ method: 'DELETE', url: '/api/stories/unknown', payload: body })).statusCode).toBe(404)
  })

  it('rejects replaying the creation request of a deleted conversation and reports a missing fork source', async () => {
    const x = await setup(), payload = { requestId: randomUUID(), title: '创建去重', profile: { scene: { openingSource: 'custom', openingText: '独立分支原文' } } }
    const created = (await x.call({ method: 'POST', url: '/api/stories', payload })).json().story
    const child = x.service.fork(created.id, created.revision, created.messages[0].id)
    expect((await x.call({ method: 'DELETE', url: `/api/stories/${created.id}`, payload: { expectedRevision: created.revision } })).statusCode).toBe(204)
    const replay = await x.call({ method: 'POST', url: '/api/stories', payload })
    expect(replay.statusCode).toBe(409); expect(replay.json().error.code).toBe('STORY_DELETED')
    const branch = (await x.call({ url: `/api/stories/${child.id}` })).json()
    expect(branch.forkSourceAvailable).toBe(false)
    expect(branch.story.messages[0].text).toBe('独立分支原文')
    expect((await x.call({ url: '/api/stories' })).statusCode).toBe(200)
  })

  it('refuses deleting an active generation until it has durably stopped', async () => {
    const x = await setup('wait')
    const response = await x.call({ method: 'POST', url: x.base + '/messages', payload: { requestId: randomUUID(), inputs: [{ text: '保持运行', attachmentIds: [] }] } })
    await new Promise(resolve => setTimeout(resolve, 20))
    const blocked = await x.call({ method: 'DELETE', url: x.base, payload: { expectedRevision: x.stories.snapshot(x.storyId).revision } })
    expect(blocked.statusCode).toBe(409); expect(blocked.json().error.code).toBe('STORY_BUSY')
    await x.call({ method: 'POST', url: `/api/runs/${response.json().run.id}/stop` }); await x.queue.idle()
    expect((await x.call({ method: 'DELETE', url: x.base, payload: { expectedRevision: x.stories.snapshot(x.storyId).revision } })).statusCode).toBe(204)
  })

  it('clears failed-turn feedback when its input is deleted, including after a fresh read', async () => {
    const x = await setup(), error = { code: 'MODEL_CONTENT_FILTER', message: '合成提供方中止了生成。' }
    const { run } = x.service.send(x.storyId, 'failed-input', [{ text: '查看灯塔来信', attachmentIds: [] }])
    x.stories.setRunStatus(run.id, 'running'); x.stories.setRunStatus(run.id, 'failed', error)
    const before = (await x.call({ url: x.base })).json()
    expect(before.story.conversationRunId).toBe(run.id)
    expect(searchStories(x.stories, false)[0]?.status).toBe('failed')
    const removed = await x.call({ method: 'DELETE', url: x.base + `/messages/${before.story.messages[0].id}`, payload: { expectedRevision: before.story.revision } })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().story).toMatchObject({ messages: [], conversationRunId: null })
    const fresh = (await x.call({ url: x.base })).json()
    expect(fresh.story).toMatchObject({ messages: [], conversationRunId: null })
    expect(searchStories(x.stories, false)[0]?.status).toBeNull()
    expect(fresh.runs).toMatchObject([{ id: run.id, status: 'failed', error }])
    expect(x.stories.runPage(x.storyId).runs[0]).toMatchObject({ id: run.id, error })
  })

  it.each(['failed', 'cancelled', 'interrupted'] as const)('does not resurrect a deleted %s draft while keeping its input recoverable', async status => {
    const x = await setup(), text = '这段草稿被用户明确删除。'
    const { run } = x.service.send(x.storyId, `draft-${status}`, [{ text: '沿海岸继续调查', attachmentIds: [] }])
    x.stories.setRunStatus(run.id, 'running'); x.stories.saveDraft(run.id, text)
    x.stories.setRunStatus(run.id, status, status === 'failed' ? { code: 'SYNTHETIC_FAILURE', message: '生成未完成' } : undefined)
    const before = (await x.call({ url: x.base })).json(), draft = before.story.messages.find((message: { kind: string }) => message.kind === 'draft')
    expect(before.story.conversationRunId).toBe(run.id)
    expect(before.runs[0].draft).toBe(text)
    const removed = await x.call({ method: 'DELETE', url: x.base + `/messages/${draft.id}`, payload: { expectedRevision: before.story.revision } })
    expect(removed.statusCode).toBe(200)
    const fresh = (await x.call({ url: x.base })).json()
    expect(fresh.story.conversationRunId).toBeNull()
    expect(searchStories(x.stories, false)[0]?.status).toBeNull()
    expect(fresh.story.messages).toMatchObject([{ role: 'user', runId: run.id }])
    expect(fresh.story.messages).toHaveLength(1)
    expect(fresh.runs[0].draft).toBe('')
    expect(x.stories.run(run.id).draft).toBe(text)
    const replay = await x.call({ method: 'POST', url: x.base + `/messages/${fresh.story.messages[0].id}/regenerate`, payload: { expectedRevision: fresh.story.revision, requestId: `retry-${status}` } })
    expect(replay.statusCode).toBe(202)
    await x.queue.idle()
    const regenerated = (await x.call({ url: x.base })).json()
    expect(regenerated.story.conversationRunId).toBe(replay.json().run.id)
    expect(searchStories(x.stories, false)[0]?.status).toBe('completed')
    expect(regenerated.story.messages.some((message: { text: string }) => message.text === text)).toBe(false)
  })

  it('restores the visible tail run after deleting newer rounds beyond the recent-run page', async () => {
    const x = await setup(), inputs: { id: string; runId: string }[] = []
    for (let index = 0; index < 32; index++) {
      const { run } = x.service.send(x.storyId, `history-${index}`, [{ text: `调查第 ${index} 处线索`, attachmentIds: [] }])
      x.stories.setRunStatus(run.id, 'running'); x.stories.setRunStatus(run.id, 'failed', { code: 'SYNTHETIC_FAILURE', message: '未生成正文' })
      x.database.sqlite.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(new Date(Date.UTC(2026, 8, 7, 0, 0, index)).toISOString(), run.id)
      inputs.push({ id: x.stories.snapshot(x.storyId).messages.at(-1)!.id, runId: run.id })
    }
    const first = inputs[0]!, second = inputs[1]!
    expect(x.stories.storyRuns(x.storyId).some(run => run.id === first.runId)).toBe(false)
    expect((await x.call({ method: 'DELETE', url: x.base + `/messages/${second.id}`, payload: { expectedRevision: x.stories.snapshot(x.storyId).revision } })).statusCode).toBe(200)
    const fresh = (await x.call({ url: x.base })).json()
    expect(fresh.story.conversationRunId).toBe(first.runId)
    expect(searchStories(x.stories, false)[0]?.status).toBe('failed')
    expect(fresh.story.messages).toMatchObject([{ id: first.id }])
    expect(fresh.runs.some((run: { id: string }) => run.id === first.runId)).toBe(true)
    const other = x.service.create('独立会话')
    expect(x.stories.storyRuns(other.id, 30, first.runId)).toEqual([])
  })

  it('removes the conversation feedback command endpoint without altering saved story data', async () => {
    const x = await setup(), before = x.stories.snapshot(x.storyId)
    const response = await x.call({ method: 'POST', url: x.base + '/feedback', payload: { requestId: 'removed-command', text: '旧指令' } })
    expect(response.statusCode).toBe(404)
    expect(x.stories.snapshot(x.storyId)).toEqual(before)
    expect(x.stories.storyRuns(x.storyId)).toHaveLength(0)
  })
  it('reads paged plot recaps with authentication, excludes summarized or removed replies, and never writes on read', async () => {
    const x = await setup()
    expect((await x.app.inject({ url: x.base + '/recap' })).statusCode).toBe(401)
    for (let index = 0; index < 6; index++) {
      expect((await x.call({ method: 'POST', url: x.base + '/messages', payload: { requestId: `recap-${index}`, inputs: [{ text: `继续调查 ${index}`, attachmentIds: [] }] } })).statusCode).toBe(202)
      await x.queue.idle()
    }
    const snapshot = x.stories.snapshot(x.storyId), first = (await x.call({ url: x.base + '/recap' })).json()
    expect(first.items).toHaveLength(5)
    const second = (await x.call({ url: x.base + `/recap?before=${first.before}` })).json()
    expect([...first.items, ...second.items]).toEqual(snapshot.summaries.toReversed())
    expect(second.before).toBeNull()
    expect((await x.call({ url: x.base })).json().story.summaries).toEqual([])
    expect(x.stories.snapshot(x.storyId).revision).toBe(snapshot.revision)
    expect((await x.call({ url: x.base + '/recap?before=missing' })).statusCode).toBe(409)
    const oldest = snapshot.summaries[0]!.messageId
    x.stories.append(x.storyId, {type:'summary.created', data:{throughMessageId:oldest,sourceMessageIds:[oldest],text:'较早的剧情已概括。'}})
    expect((await x.call({ url: x.base + '/recap' })).json().total).toBe(5)
    const latest = snapshot.summaries.at(-1)!.messageId
    const removed = await x.call({method:'DELETE',url:x.base + `/messages/${latest}`,payload:{expectedRevision:x.stories.snapshot(x.storyId).revision}})
    expect(removed.statusCode).toBe(200)
    const remaining = (await x.call({url:x.base + '/recap'})).json()
    expect(remaining.total).toBe(4)
    expect(remaining.items.some((item: {messageId:string}) => item.messageId === latest || item.messageId === oldest)).toBe(false)
  })

  it('creates a selected opening exactly once, preserves bindings, and rejects a changed retry', async () => {
    const x = await setup(), requestId = randomUUID()
    const card = x.assets.create('character', { name: '守塔人', firstMessage: '', alternateGreetings: ['', '你好，{{user}}。我是{{char}}。'] })
    const persona = x.assets.create('persona', { name: '林舟' })
    const book = x.assets.create('lorebook', { name: '灯塔档案', entries: [] })
    const payload = { requestId, title: '灯塔新会话', useDefaults: false, profile: { resources: { card: { id: card.id }, persona: { id: persona.id }, lorebooks: [{ id: book.id }], writingStyles: [] }, scene: { openingSource: 'card', openingIndex: 2 } } }
    const first = await x.call({ method: 'POST', url: '/api/stories', payload })
    expect(first.statusCode).toBe(201)
    const retry = await x.call({ method: 'POST', url: '/api/stories', payload })
    expect(retry.json().story).toEqual(first.json().story)
    expect(x.stories.list()).toHaveLength(2)
    expect(x.stories.snapshot(requestId).messages).toMatchObject([{ kind: 'opening', text: '你好，林舟。我是守塔人。' }])
    expect(x.stories.snapshot(requestId).profile.resources.lorebooks).toEqual([{ id: book.id }])
    expect(x.stories.storyRuns(requestId)).toHaveLength(0)
    expect((await x.call({ method: 'POST', url: '/api/stories', payload: { ...payload, title: '不同内容' } })).statusCode).toBe(409)
    expect(x.stories.list()).toHaveLength(2)
  })

  it('starts from the first message atomically and retries without duplicate conversations or inputs', async () => {
    const x = await setup(), requestId = randomUUID()
    const file = x.files.save(Buffer.from('合成附件'), '开场资料.txt', 'text/plain')
    const payload = { requestId, title: '从输入开始', inputs: [{ text: '向海岸出发', attachmentIds: [file.id] }] }
    const first = await x.call({ method: 'POST', url: '/api/stories/start', payload })
    expect(first.statusCode).toBe(202)
    await x.queue.idle()
    expect((await x.call({ method: 'POST', url: '/api/stories/start', payload })).json()).toEqual({ storyId: requestId, duplicate: true })
    expect(x.stories.list()).toHaveLength(2)
    expect(x.stories.storyRuns(requestId)).toHaveLength(1)
    expect(x.stories.snapshot(requestId).messages.filter(message => message.role === 'user')).toMatchObject([{ text: '向海岸出发', attachmentIds: [file.id] }])
    expect((await x.call({ method: 'POST', url: '/api/stories/start', payload: { ...payload, inputs: [{ text: '更换输入', attachmentIds: [] }] } })).statusCode).toBe(409)
    const invalidId = randomUUID()
    expect((await x.call({ method: 'POST', url: '/api/stories/start', payload: { ...payload, requestId: invalidId, inputs: [{ text: '缺失附件', attachmentIds: ['missing'] }] } })).statusCode).toBe(404)
    expect(x.stories.exists(invalidId)).toBe(false)
    expect(x.stories.list()).toHaveLength(2)
  })

  it('does not leave empty conversations when the selected workspace is unavailable', async () => {
    const x = await setup()
    for (const url of ['/api/stories', '/api/stories/start']) {
      const requestId = randomUUID()
      expect((await x.call({ method: 'POST', url, payload: { requestId, title: '不可用的工作区', workspaceId: 'missing', ...(url.endsWith('/start') ? { inputs: [{ text: '继续', attachmentIds: [] }] } : {}) } })).statusCode).toBe(404)
      expect(x.stories.exists(requestId)).toBe(false)
    }
    expect(x.stories.list()).toHaveLength(1)
  })

  it('starts a conversation with its opening, workspace and first message atomically, and retries without duplicating it', async () => {
    const x = await setup(), requestId = randomUUID(), workspaceId = randomUUID()
    const now = new Date().toISOString()
    x.stories.database.sqlite.prepare('INSERT INTO workspaces VALUES (?,?,?,?,1,?,?)').run(workspaceId, '创作', 'writing', 'read-only', now, now)
    const card = x.assets.create('character', { name: '守灯人', firstMessage: '灯塔的门开着。' })
    const payload = { requestId, title: '第一次来信', workspaceId, profile: { resources: { card: { id: card.id } }, scene: { openingSource: 'card', openingIndex: 0 } }, inputs: [{ text: '我把信放在桌上。', attachmentIds: [] }] }
    const before = x.stories.list().length
    const started = await x.call({ method: 'POST', url: '/api/stories/start', payload })
    expect(started.statusCode).toBe(202)
    expect(started.json()).toEqual({ storyId: requestId, duplicate: false })
    await x.queue.idle()
    const retry = await x.call({ method: 'POST', url: '/api/stories/start', payload })
    expect(retry.statusCode).toBe(202)
    expect(retry.json()).toEqual({ storyId: requestId, duplicate: true })
    expect(x.stories.list()).toHaveLength(before + 1)
    expect(x.stories.storyRuns(requestId)).toHaveLength(1)
    expect(x.stories.workspaceBinding(requestId)).toMatchObject({ workspaceId, access: 'read-only', directory: 'writing' })
    expect(x.stories.snapshot(requestId).messages.map(message => message.text)).toEqual(['灯塔的门开着。', '我把信放在桌上。', '沿着海岸继续前行。'])
    const conflict = await x.call({ method: 'POST', url: '/api/stories/start', payload: { ...payload, title: '其他内容' } })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error.code).toBe('REQUEST_CONFLICT')
  })

  it('does not leave an empty conversation when the first message or workspace is invalid', async () => {
    const x = await setup(), requestId = randomUUID(), before = x.stories.list().length
    const payload = { requestId, title: '尚未发送', inputs: [{ text: ' ', attachmentIds: [] as string[] }] }
    expect((await x.call({ method: 'POST', url: '/api/stories/start', payload })).statusCode).toBe(400)
    expect(x.stories.exists(requestId)).toBe(false)
    const missingFile = await x.call({ method: 'POST', url: '/api/stories/start', payload: { ...payload, inputs: [{ text: '参考附件', attachmentIds: [randomUUID()] }] } })
    expect(missingFile.statusCode).toBe(404)
    expect(x.stories.exists(requestId)).toBe(false)
    const missingWorkspace = await x.call({ method: 'POST', url: '/api/stories/start', payload: { ...payload, workspaceId: randomUUID(), inputs: [{ text: '你好', attachmentIds: [] }] } })
    expect(missingWorkspace.statusCode).toBe(404)
    expect(x.stories.list()).toHaveLength(before)
    const corrected = await x.call({ method: 'POST', url: '/api/stories/start', payload: { ...payload, inputs: [{ text: '已修正', attachmentIds: [] }] } })
    expect(corrected.statusCode).toBe(202)
    await x.queue.idle()
    expect(x.stories.list()).toHaveLength(before + 1)
  })

  it('authenticates first-message creation and rejects attempts to reuse an existing conversation ID', async () => {
    const x = await setup()
    const payload = { requestId: x.storyId, title: '不能覆盖', inputs: [{ text: '新内容', attachmentIds: [] }] }
    expect((await x.app.inject({ method: 'POST', url: '/api/stories/start', headers: { origin }, payload })).statusCode).toBe(401)
    expect((await x.call({ method: 'POST', url: '/api/stories/start', payload })).statusCode).toBe(409)
    expect(x.stories.snapshot(x.storyId).title).toBe('接口故事')
    expect(x.stories.snapshot(x.storyId).messages).toHaveLength(0)
  })

  it('pages all historical runs without shifting cursors when a new run arrives, and preserves removed tool audit records', async () => {
    const x = await setup(), ids: string[] = []
    for (let index = 0; index < 33; index++) {
      const run = x.stories.enqueue({ storyId: x.storyId, requestId: `page-${index}`, inputHash: String(index), turnId: String(index) }, () => undefined).run
      x.stories.setRunStatus(run.id, 'cancelled'); ids.push(run.id)
    }
    const expected = x.stories.storyRuns(x.storyId, 100).map(run => run.id)
    const first = (await x.call({ url: x.base + '/runs' })).json()
    expect(first.runs).toHaveLength(30)
    const newest = x.stories.enqueue({ storyId: x.storyId, requestId: 'newest', inputHash: 'newest', turnId: 'newest' }, () => undefined).run
    x.stories.setRunStatus(newest.id, 'cancelled')
    const second = (await x.call({ url: x.base + `/runs?before=${first.nextCursor}` })).json()
    expect([...first.runs, ...second.runs].map(run => run.id)).toEqual(expected)
    expect(second.nextCursor).toBeNull()
    const other = new StoryService(x.stories, x.assets, x.files).create('其他故事')
    expect((await x.call({ url: `/api/stories/${other.id}/runs?before=${first.nextCursor}` })).statusCode).toBe(400)
    const runId = ids[0]!
    x.stories.append(x.storyId, { type: 'tool.started', data: { callId: 'historical', runId, name: 'Bash', arguments: { command: 'pwd' }, status: 'running' } })
    x.stories.append(x.storyId, { type: 'tool.finished', data: { callId: 'historical', result: { stdout: '/workspace' }, failed: false } })
    expect(x.stories.snapshot(x.storyId).tools).toHaveLength(0)
    expect((await x.call({ url: `/api/runs/${runId}/tools` })).json().tools).toMatchObject([{ callId: 'historical', status: 'completed', result: { stdout: '/workspace' } }])
  })
  it('persists an idempotent turn, exposes its frozen context, and supports edit, fork, regeneration and archive with revisions', async () => {
    const x = await setup(), payload = { requestId: 'send-1', inputs: [{ text: '向海边出发', attachmentIds: [] }] }
    const send = await x.call({ method: 'POST', url: x.base + '/messages', payload })
    expect(send.statusCode).toBe(202); await x.queue.idle()
    const retry = await x.call({ method: 'POST', url: x.base + '/messages', payload })
    expect(retry.json()).toMatchObject({ duplicate: true, run: { id: send.json().run.id, status: 'completed' } })
    expect((await x.call({ method: 'POST', url: x.base + '/messages', payload: { ...payload, inputs: [{ text: '另一个请求', attachmentIds: [] }] } })).json().error.code).toBe('REQUEST_CONFLICT')
    const runBase = `/api/runs/${send.json().run.id}`
    expect((await x.call({ url: runBase + '/context' })).json().contexts[0].data.writerPrompt).toBe('冻结的写作资料')
    expect((await x.call({ method: 'POST', url: runBase + '/stop' })).json().run.status).toBe('completed')
    let story = (await x.call({ url: x.base })).json().story
    expect(story.messages.map((message: { kind: string }) => message.kind)).toEqual(['message', 'narrative'])
    const originalRevision = story.revision, userId = story.messages[0].id, replyId = story.messages[1].id
    expect((await x.call({ url: x.base + `/messages/${replyId}/state` })).json()).toEqual({ before: { namespaces: {} }, after: { namespaces: {} } })
    expect((await x.call({ url: x.base + `/messages/${userId}/state` })).statusCode).toBe(404)
    story = (await x.call({ method: 'PATCH', url: x.base + `/messages/${replyId}`, payload: { expectedRevision: story.revision, text: '沿着新的海岸前行。' } })).json().story
    const stale = await x.call({ method: 'PATCH', url: x.base + '/title', payload: { expectedRevision: originalRevision, title: '过期写入' } })
    expect(stale.statusCode).toBe(409)
    const fork = await x.call({ method: 'POST', url: x.base + `/messages/${replyId}/fork`, payload: { expectedRevision: story.revision } })
    expect(fork.statusCode).toBe(201)
    expect(fork.json().story).toMatchObject({ forkedFrom: { storyId: x.storyId, messageId: replyId } })
    expect(fork.json().story.messages[1].text).toBe('沿着新的海岸前行。')
    story = (await x.call({ method: 'PATCH', url: x.base + `/messages/${userId}`, payload: { expectedRevision: story.revision, text: '改去港口' } })).json().story
    const regenerate = { expectedRevision: story.revision, requestId: 'retry-1' }
    expect((await x.call({ method: 'POST', url: x.base + `/messages/${replyId}/regenerate`, payload: regenerate })).statusCode).toBe(202)
    await x.queue.idle()
    expect((await x.call({ method: 'POST', url: x.base + `/messages/${replyId}/regenerate`, payload: regenerate })).json().duplicate).toBe(true)
    story = (await x.call({ url: x.base })).json().story
    expect(story.messages[0].text).toBe('改去港口'); expect(story.messages).toHaveLength(2)
    story = (await x.call({ method: 'DELETE', url: x.base + `/messages/${story.messages[1].id}`, payload: { expectedRevision: story.revision } })).json().story
    expect(story.messages).toHaveLength(1)
    expect((await x.call({ method: 'PATCH', url: x.base + '/archive', payload: { expectedRevision: story.revision, archived: true } })).json().story.archived).toBe(true)
    expect((await x.call({ url: '/api/stories?archived=true' })).json().stories.map((item: { id: string }) => item.id)).toContain(x.storyId)
    expect((await x.call({ method: 'POST', url: x.base + '/messages', payload: { ...payload, requestId: 'send-2' } })).json().error.code).toBe('STORY_ARCHIVED')
  })

  it('authenticates commands, rejects extra fields and stops an active run without accepting concurrent edits', async () => {
    const x = await setup('wait')
    expect((await x.app.inject({ url: x.base })).statusCode).toBe(401)
    expect((await x.call({ method: 'POST', url: '/api/stories', payload: { title: '坏格式', admin: true } })).statusCode).toBe(400)
    const send = await x.call({ method: 'POST', url: x.base + '/messages', payload: { requestId: 'waiting', inputs: [{ text: '继续', attachmentIds: [] }] } })
    const run = send.json().run, story = x.stories.snapshot(x.storyId)
    expect((await x.call({ method: 'PATCH', url: x.base + '/title', payload: { expectedRevision: story.revision, title: '执行中编辑' } })).json().error.code).toBe('STORY_BUSY')
    expect((await x.call({ url: `/api/runs/${run.id}/context` })).statusCode).toBe(404)
    expect((await x.call({ method: 'POST', url: `/api/runs/${run.id}/stop` })).statusCode).toBe(200)
    await x.queue.idle()
    expect((await x.call({ url: `/api/runs/${run.id}` })).json().run.status).toBe('cancelled')
    expect((await x.call({ method: 'POST', url: `/api/runs/${run.id}/stop` })).json().run.status).toBe('cancelled')
  })

  it('answers a durable question once and resumes the waiting run through the same API', async () => {
    const x = await setup('ask')
    const send = await x.call({ method: 'POST', url: x.base + '/messages', payload: { requestId: 'question', inputs: [{ text: '安排旅行', attachmentIds: [] }] } })
    const story = (await x.call({ url: x.base })).json().story, question = story.questions[0]
    expect((await x.call({ url: `/api/runs/${send.json().run.id}` })).json().run.status).toBe('waiting_user')
    const url = x.base + `/questions/${question.id}/answer`, payload = { answers: [{ id: 'direction', selected: ['海边'] }] }
    expect((await x.call({ method: 'POST', url, payload })).json().duplicate).toBe(false)
    await x.queue.idle()
    expect((await x.call({ method: 'POST', url, payload })).json().duplicate).toBe(true)
    expect((await x.call({ method: 'POST', url, payload: { answers: [{ id: 'direction', selected: ['山中'] }] } })).json().error.code).toBe('ANSWER_CONFLICT')
    expect(x.stories.run(send.json().run.id).status).toBe('completed')
  })
})
