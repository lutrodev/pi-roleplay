import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from '../apps/server/src/server.ts'
import { createToolServer } from '../apps/tools/src/server.ts'
import type { ServerConfig } from '../apps/server/src/config.ts'
import type { Preferences } from '../packages/rp-core/src/settings/preferences.ts'
import type { JsonObject } from '../packages/rp-core/src/types.ts'
import { SUMMARY_HEADINGS } from '../packages/rp-core/src/context/summary.ts'
import { message } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
type Reply = { text?: string; call?: { name: string; arguments: object } }
const route = { provider: 'synthetic', model: 'roleplay' }, password = 'synthetic-server-password', origin = 'http://rp.test'

async function setup(replies: Reply[], onRequest?: (index: number, signal?: AbortSignal | null) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-application-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const inputs = join(directory, 'data/inputs'), workspaces = join(directory, 'workspaces'), skills = join(directory, 'skills'), webDirectory = join(directory, 'web')
  await Promise.all([inputs, workspaces, skills, webDirectory].map(path => mkdir(path, { recursive: true })))
  await writeFile(join(webDirectory, 'index.html'), '<!doctype html><html><body>Application route fixture</body></html>')
  const token = 'synthetic-app-tool-token-0123456789abcdef'
  const toolServer = createToolServer({ token, roots: { inputs, workspaces, skills } })
  cleanup.push(() => toolServer.app.close())
  const toolUrl = await toolServer.app.listen({ host: '127.0.0.1', port: 0 })
  const config: ServerConfig = { dataDirectory: join(directory, 'data'), sessionKey: randomBytes(32), publicOrigin: origin, tools: { url: toolUrl, token }, defaultMain: route,
    models: [{ ...route, keyEnv: 'RP_SYNTHETIC_KEY', api: 'openai-completions', baseUrl: 'https://model.test/v1', contextWindow: 128000, maxTokens: 8192 }],
    skillRoots: [{ path: fileURLToPath(new URL('../skills/builtin', import.meta.url)), virtualPath: '/skills/builtin' }, { path: skills, virtualPath: '/skills/custom' }], webDirectory }
  const requests: JsonObject[] = [], headers: Headers[] = []
  const modelOptions = { env: () => 'synthetic-provider-secret', fetch: async (_url: unknown, init?: RequestInit) => {
    const index = requests.length; requests.push(JSON.parse(String(init?.body))); headers.push(new Headers(init?.headers))
    await onRequest?.(index, init?.signal)
    const next = replies[index]; if (!next) throw new Error('Unexpected provider request')
    const delta = { role: 'assistant', content: next.text ?? '', ...(next.call ? { tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: next.call.name, arguments: JSON.stringify(next.call.arguments) } }] } : {}) }
    return new Response(`data: ${JSON.stringify({ id: `response-${index}`, choices: [{ index: 0, delta, finish_reason: next.call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  } }
  const application = await createServer(config, { modelOptions })
  cleanup.push(() => application.app.close())
  await application.auth.setPassword(password)
  const url = await application.app.listen({ host: '127.0.0.1', port: 0 })
  const login = await fetch(url + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  async function call(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(url + path, { method, headers: { origin, cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  return { ...application, url, cookie, config, modelOptions, call, requests, headers, directory, toolServer }
}

describe('assembled single-process application', () => {
  it('starts sessions writable and advertises only permitted Pi tools after changing one session to readonly', async () => {
    const text = '只读会话可以继续写作。'
    const x = await setup([{ call: { name: 'read', arguments: { file_path: '.' } } }, { call: { name: 'rp_write_turn', arguments: { action: 'write' } } }, { text }, { call: { name: 'rp_commit_turn', arguments: { narrative: text, runSummary: '只读工作区中完成创作。' } } }])
    const preferences = x.settings.snapshot()
    x.settings.update(preferences.revision, { ...preferences.preferences, replyOptionsEnabled: false })
    const original = x.service.create('已有可写会话')
    const story = x.service.create('单独设置只读')
    expect(x.workspaces.forStory(story.id).access).toBe('read-write')
    const workspace = (await x.call(`/api/stories/${story.id}/workspace`)).body
    expect((await x.call(`/api/stories/${story.id}/workspace`, 'PUT', { expectedRevision: workspace.revision, workspaceId: null, access: 'read-only' })).status).toBe(200)
    expect(x.workspaces.forStory(original.id).access).toBe('read-write')
    expect(x.workspaces.forStory(story.id).access).toBe('read-only')
    x.service.updateProfile(story.id, x.stories.latestSequence(story.id), { ...story.profile, runtime: { ...story.profile.runtime, executionMode: 'agent' } })
    const sent = await x.call(`/api/stories/${story.id}/messages`, 'POST', { requestId: randomUUID(), inputs: [{ text: '检查当前文件权限。', attachmentIds: [] }] })
    await x.queue.idle()
    expect(x.stories.run(sent.body.run.id).status).toBe('completed')
    expect(x.stories.snapshot(story.id).messages.at(-1)?.text).toBe(text)
    const names = (x.requests[0]!.tools as { function: { name: string } }[]).map(tool => tool.function.name)
    expect(names).toContain('read')
    for (const name of ['bash', 'write', 'edit', 'str_replace_editor']) expect(names).not.toContain(name)
    const current = (await x.call(`/api/stories/${story.id}/workspace`)).body
    expect((await x.call(`/api/stories/${story.id}/workspace`, 'PUT', { expectedRevision: current.revision, workspaceId: null, access: 'read-write' })).status).toBe(200)
    expect(x.workspaces.forStory(story.id).access).toBe('read-write')
  })

  it('saves tool settings through authenticated HTTP and enforces the saved limits in the actual Pi and Bash run', async () => {
    const x = await setup([{ call: { name: 'bash', arguments: { command: 'printf "%01000d" 0; sleep 10' } } }, { text: '工具超时已记录。' }])
    expect((await fetch(x.url + '/api/settings/tools')).status).toBe(401)
    const initial = (await x.call('/api/settings/tools')).body
    const settings = { ...initial.settings, commandTimeoutMs: 100, maxOutputBytes: 16, maxParallelToolCalls: 2 }
    const saved = await x.call('/api/settings/tools', 'PUT', { expectedRevision: initial.revision, settings })
    expect(saved.status).toBe(200)
    expect((await x.call('/api/settings/tools', 'PUT', { expectedRevision: initial.revision, settings })).status).toBe(409)
    expect((await x.call('/api/settings/tools', 'PUT', { expectedRevision: saved.body.revision, settings: { ...settings, maxOutputBytes: 0 } })).status).toBe(400)
    expect((await x.call('/api/settings/tools')).body).toEqual(saved.body)
    const story = x.service.create('工具参数实测'), profile = { ...story.profile, runtime: { ...story.profile.runtime, executionMode: 'agent' as const } }
    x.service.updateProfile(story.id, story.revision, profile)
    const sent = await x.call(`/api/stories/${story.id}/messages`, 'POST', { requestId: randomUUID(), inputs: [{ text: '检查工具输出。', attachmentIds: [] }] })
    expect(sent.status).toBe(202); await x.queue.idle()
    expect(x.stories.run(sent.body.run.id).status).toBe('completed')
    const tool = x.stories.snapshot(story.id).tools.find(item => item.name === 'bash')!
    expect(JSON.stringify(tool.result)).toContain('TOOL_TIMEOUT')
    expect(JSON.stringify(tool.result)).toContain('outputFile')
    expect(x.stories.eventLog(story.id).some(event => event.type === 'model.message' && event.data.role === 'runtime:tool-settings')).toBe(true)
    const schema = (x.requests[0]!.tools as { function: { name: string; parameters: { properties: { timeout_ms: { maximum: number } } } } }[]).find(tool => tool.function.name === 'bash')!
    expect(schema.function.parameters.properties.timeout_ms.maximum).toBe(100)
  })
  it('uses the application error envelope for login failures, malformed input and rejected origins', async () => {
    const x = await setup([])
    for (const test of [
      { headers: { origin }, body: { password: 'incorrect-test-password' }, status: 401, code: 'LOGIN_FAILED', message: '密码不正确。' },
      { headers: { origin }, body: { password, unexpected: true }, status: 400, code: 'INVALID_REQUEST', message: '请求格式不正确，请检查填写内容。' },
      { headers: { origin: 'https://outside.test' }, body: { password }, status: 403, code: 'ORIGIN_REJECTED', message: '请求来源与应用地址不一致，请从正常页面重试。' },
    ]) {
      const response = await fetch(x.url + '/api/auth/login', { method: 'POST', headers: { ...test.headers, 'content-type': 'application/json' }, body: JSON.stringify(test.body) })
      expect(response.status).toBe(test.status)
      const body = await response.json()
      expect(body).toMatchObject({ error: { code: test.code, message: test.message } })
      expect(JSON.stringify(body)).not.toContain(test.body.password)
    }
    expect(x.requests).toHaveLength(0)
  })
  it('previews unsaved RP materials without mutating the story or invoking a provider, and reports effective guide dependencies', async () => {
    const x = await setup([]), story = x.service.create('资料预览')
    const draft = structuredClone(story.profile)
    draft.contextBuild = { version: 1, slots: [{ id: 'custom-note', label: '我的资料', sourceIds: ['rp.custom:custom-note'] }], customSources: [{ slotId: 'custom-note', content: '这次故事发生在冬天。' }] }
    const preview = await x.call(`/api/stories/${story.id}/context-preview`, 'POST', { profile: draft })
    expect(preview.status).toBe(200)
    expect(preview.body.writerPrompt).toContain('这次故事发生在冬天。')
    expect(preview.body.layout.slots.some((slot: { id: string }) => slot.id === 'custom-note')).toBe(true)
    expect(x.stories.snapshot(story.id)).toEqual(story)
    expect(x.requests).toHaveLength(0)
    expect((await x.call('/api/settings/models')).body.effectiveMain).toEqual(route)
    draft.contextBuild.customSources![0]!.content = ''
    expect((await x.call(`/api/stories/${story.id}/context-preview`, 'POST', { profile: draft })).status).toBe(400)
    const current = x.settings.snapshot()
    x.settings.update(current.revision, { ...current.preferences, disabledSkills: ['rp-guide-preset'] })
    const skills = (await x.call('/api/settings/skills')).body.skills
    expect(skills.filter((skill: { name: string }) => skill.name.startsWith('rp-guide-preset')).every((skill: { enabled: boolean }) => !skill.enabled)).toBe(true)
  })
  it('exposes manual summary acceptance, diagnostics and source-preserving checkpoints through authenticated HTTP', async () => {
    const text = SUMMARY_HEADINGS.map(heading => `${heading}\n- 灯塔已经点亮。`).join('\n\n')
    const x = await setup([{ text }]), story = x.service.create('手动总结')
    const messages = [message('user', '以前的请求。'.repeat(500), { turnId: 'old' }), message('assistant', '以前的正文。'.repeat(500), { turnId: 'old', kind: 'narrative' }),
      message('user', '最近的请求。', { turnId: 'recent' }), message('assistant', '最近的正文。', { turnId: 'recent', kind: 'narrative' })]
    for (const item of messages) x.stories.append(story.id, { type: 'message.added', data: { message: item } })
    const body = { expectedRevision: x.stories.snapshot(story.id).revision, requestId: 'manual-http' }
    const accepted = await x.call(`/api/stories/${story.id}/summaries`, 'POST', body)
    expect(accepted.status).toBe(202); await x.summaries.idle()
    expect((await x.call(`/api/stories/${story.id}/summaries`, 'POST', body)).body).toEqual({ id: accepted.body.id, duplicate: true })
    const snapshot = (await x.call(`/api/stories/${story.id}`)).body.story
    expect(snapshot.checkpoint).toMatchObject({ text, sourceMessageIds: messages.map(message => message.id) })
    expect(snapshot.messages).toHaveLength(4)
    const records = await x.call(`/api/stories/${story.id}/summaries/${accepted.body.id}`)
    expect(records.status).toBe(200); expect(records.body.records.filter((event: { type: string }) => event.type === 'maintenance.model')).toHaveLength(2)
    expect((await x.call(`/api/stories/${story.id}/summaries/missing/stop`, 'POST')).status).toBe(409)
    expect(x.requests).toHaveLength(1)
  })
  it('runs authenticated story → Pi → Writer → commit, serves settings and static routes, and downloads files through the real tool service', async () => {
    const x = await setup([{ call: { name: 'rp_write_turn', arguments: { action: 'write' } } }, { text: '海风掠过灯塔。' }, { call: { name: 'rp_commit_turn', arguments: { runSummary: '灯塔的一天。' } } }, { call: { name: 'emit_reply_options', arguments: { options: ['他走向海边。', '他留在塔内。', '他推开窗户。'] } } }])
    expect((await fetch(x.url + '/api/stories')).status).toBe(401)
    expect((await fetch(x.url + '/health')).status).toBe(200)
    expect(await (await fetch(x.url + '/stories/example', { headers: { accept: 'text/html' } })).text()).toContain('Application route fixture')
    expect((await fetch(x.url + '/api/missing', { headers: { accept: 'text/html', cookie: x.cookie } })).status).toBe(404)
    const created = await x.call('/api/stories', 'POST', { title: '海岸' }); expect(created.status).toBe(201)
    const id = created.body.story.id
    const sent = await x.call(`/api/stories/${id}/messages`, 'POST', { requestId: randomUUID(), inputs: [{ text: '请继续故事。', attachmentIds: [] }] })
    expect(sent.status).toBe(202); await x.queue.idle()
    const story = (await x.call(`/api/stories/${id}`)).body.story
    expect(story.messages.at(-1)).toMatchObject({ kind: 'narrative', text: '海风掠过灯塔。' })
    expect(x.stories.run(sent.body.run.id).status).toBe('completed'); expect(x.requests).toHaveLength(4)
    expect(x.stories.snapshot(id).replyOptions[story.messages.at(-1).id]).toEqual(['他走向海边。', '他留在塔内。', '他推开窗户。'])
    expect(x.headers.every(headers => headers.get('authorization') === 'Bearer synthetic-provider-secret')).toBe(true)
    const status = await x.call('/api/system/status')
    expect(status.body.tools).toMatchObject({ available: true, ok: true, active: 0 })
    expect(JSON.stringify(status.body)).not.toContain('synthetic-provider-secret')
    expect(JSON.stringify((await x.call('/api/settings/models')).body)).not.toContain('RP_SYNTHETIC_KEY')
    const skillList = (await x.call('/api/settings/skills')).body
    expect(skillList.skills).toHaveLength(7)
    const catalog = (await x.call('/api/settings/subagents')).body
    expect(catalog.subagents).toHaveLength(2)
    const createdTask = await x.call('/api/settings/subagents', 'POST', { subagent: { name: '资料核对', description: '需要核对材料时调用。', instructions: '仅核对传入材料。', route: { kind: 'inherit' }, tools: [], enabled: true } })
    expect(createdTask.status).toBe(201)
    const task = createdTask.body.subagent
    expect((await x.call(`/api/settings/subagents/${task.id}`, 'PATCH', { expectedRevision: task.revision, enabled: false })).body.subagent.enabled).toBe(false)
    expect((await x.call('/api/settings/subagents/writer', 'DELETE', { expectedRevision: 1 })).body.error.code).toBe('WRITER_FIXED')
    const preferences = (await x.call('/api/settings')).body
    const next: Preferences = { ...preferences.preferences, quickRepliesEnabled: false, quickReplies: [] }
    expect((await x.call('/api/settings', 'PUT', { expectedRevision: preferences.revision, preferences: next })).status).toBe(200)
    expect((await x.call('/api/settings', 'PUT', { expectedRevision: preferences.revision, preferences: next })).status).toBe(409)
    await x.client.execute(id, { kind: 'bash', command: 'printf "海岸笔记" > notes.txt' }, { signal: new AbortController().signal })
    expect((await x.call(`/api/stories/${id}/files`)).body.entries[0].name).toBe('notes.txt')
    expect((await x.call(`/api/stories/${id}/files/preview?path=notes.txt`)).body.text).toBe('海岸笔记')
    const file = await fetch(x.url + `/api/stories/${id}/files/download?path=notes.txt`, { headers: { cookie: x.cookie } })
    expect(await file.text()).toBe('海岸笔记'); expect(file.headers.get('content-disposition')).toContain('attachment;')
    const current = x.stories.snapshot(id)
    const forked = await x.call(`/api/stories/${id}/messages/${current.messages.at(-1)!.id}/fork`, 'POST', { expectedRevision: current.revision })
    expect(forked.status).toBe(201)
    const branchId = forked.body.story.id
    expect((await x.call(`/api/stories/${branchId}/files/preview?path=notes.txt`)).body.text).toBe('海岸笔记')
    await x.client.execute(branchId, { kind: 'edit', command: 'str_replace', path: 'notes.txt', oldText: '海岸', newText: '分支' }, { signal: new AbortController().signal })
    expect((await x.call(`/api/stories/${id}/files/preview?path=notes.txt`)).body.text).toBe('分支笔记')
    expect(x.stories.snapshot(id).messages).toEqual(current.messages)
  })

  it('keeps Writer and material tools available while task subagents and one story’s variables are disabled', async () => {
    const x = await setup([{ call: { name: 'rp_write_turn', arguments: { action: 'write' } } }, { text: '正常完成的正文。' }, { call: { name: 'rp_commit_turn', arguments: { narrative: '正常完成的正文。' } } }])
    const settings = (await x.call('/api/settings')).body
    const saved = await x.call('/api/settings', 'PUT', { expectedRevision: settings.revision, preferences: { ...settings.preferences, subagentsEnabled: false, replyOptionsEnabled: false } })
    expect(saved.status).toBe(200)
    expect((await x.call('/api/settings')).body).not.toHaveProperty('features')
    expect((await x.call('/api/settings/subagents')).body.subagents.some((item: { enabled: boolean }) => item.enabled)).toBe(true)
    const created = (await x.call('/api/stories', 'POST', { title: '独立变量设置' })).body.story
    const updated = await x.call(`/api/stories/${created.id}/profile`, 'PUT', { expectedRevision: created.revision, profile: { ...created.profile, runtime: { executionMode: 'agent' }, variables: { enabled: false, mvu: true } } })
    expect(updated.status).toBe(200)
    const sent = await x.call(`/api/stories/${created.id}/messages`, 'POST', { requestId: randomUUID(), inputs: [{ text: '继续故事', attachmentIds: [] }] })
    await x.queue.idle()
    expect(x.stories.run(sent.body.run.id).status).toBe('completed')
    expect(x.requests).toHaveLength(3)
    const names = (x.requests[0]!.tools as { function: { name: string } }[]).map(tool => tool.function.name)
    expect(names).toContain('rp_write_turn'); expect(names).toContain('rp_asset'); expect(names).toContain('rp_asset_read')
    for (const name of ['task', 'rp_state', 'rp_state_read']) expect(names).not.toContain(name)
    const story = (await x.call(`/api/stories/${created.id}`)).body.story
    expect(story.profile.variables).toEqual({ enabled: false, mvu: true })
    expect(story.messages.at(-1).text).toBe('正常完成的正文。')
  })

  it('does not start a suggestion request after its switch is disabled during Writer', async () => {
    let x: Awaited<ReturnType<typeof setup>>
    x = await setup([{ call: { name: 'rp_write_turn', arguments: { action: 'write' } } }, { text: '正文仍然完成。' }, { call: { name: 'rp_commit_turn', arguments: {} } }], async index => {
      if (index !== 1) return
      const settings = (await x.call('/api/settings')).body
      expect((await x.call('/api/settings', 'PUT', { expectedRevision: settings.revision, preferences: { ...settings.preferences, replyOptionsEnabled: false } })).status).toBe(200)
    })
    const story = x.service.create('运行中关闭建议')
    await x.call(`/api/stories/${story.id}/messages`, 'POST', { requestId: randomUUID(), inputs: [{ text: '继续', attachmentIds: [] }] })
    await x.queue.idle()
    expect(x.requests).toHaveLength(3)
    expect(x.stories.snapshot(story.id).messages.at(-1)?.text).toBe('正文仍然完成。')
    expect(x.stories.snapshot(story.id).maintenance['reply-options']).toBeUndefined()
  })

  it('skips an in-flight suggestion when disabled and finishes the same narrative commit', async () => {
    const x = await setup([{ call: { name: 'rp_write_turn', arguments: { action: 'write' } } }, { text: '正文已经保存。' }, { call: { name: 'rp_commit_turn', arguments: {} } }], async (index, signal) => {
      if (index !== 3) return
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(new Error('cancelled'))
        else signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    })
    const story = x.service.create('建议取消')
    await x.call(`/api/stories/${story.id}/messages`, 'POST', { requestId: randomUUID(), inputs: [{ text: '继续', attachmentIds: [] }] })
    await expect.poll(() => x.requests.length).toBe(4)
    const pending = x.stories.snapshot(story.id), settings = (await x.call('/api/settings')).body
    expect(pending.messages.some(message => message.kind === 'narrative')).toBe(false)
    expect(pending.replyOptions).toEqual({})
    expect((await x.call('/api/settings', 'PUT', { expectedRevision: settings.revision, preferences: { ...settings.preferences, replyOptionsEnabled: false } })).status).toBe(200)
    await x.queue.idle()
    const saved = x.stories.snapshot(story.id)
    expect(saved.messages.at(-1)?.text).toBe('正文已经保存。')
    expect(saved.maintenance['reply-options']).toBeUndefined()
    expect(x.stories.eventsOfTypes(story.id, ['turn.committed'])).toHaveLength(1)
    expect(saved.replyOptions).toEqual({})
  })

  it.each(['complete', 'stop', 'shutdown'] as const)('holds the main run at rp_commit_turn until suggestions %s', async outcome => {
    let release!: () => void
    const x = await setup([{ call: { name: 'rp_write_turn', arguments: { action: 'write' } } }, { text: '等待选项后共同保存。' },
      { call: { name: 'rp_commit_turn', arguments: {} } }, { call: { name: 'emit_reply_options', arguments: { options: ['走向海边。'] } } },
    ], async (index, signal) => {
      if (index !== 3) return
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('cancelled'))
        signal?.addEventListener('abort', abort, { once: true })
        release = () => { signal?.removeEventListener('abort', abort); resolve() }
        if (signal?.aborted) abort()
      })
    })
    const story = x.service.create('提交内生成选项')
    const sent = await x.call(`/api/stories/${story.id}/messages`, 'POST', { requestId: randomUUID(), inputs: [{ text: '继续', attachmentIds: [] }] })
    await expect.poll(() => x.requests.length).toBe(4)
    const waiting = (await x.call(`/api/stories/${story.id}`)).body.story
    expect(x.stories.run(sent.body.run.id).status).toBe('running')
    expect(waiting.messages.some((message: { kind: string }) => message.kind === 'narrative')).toBe(false)
    expect(x.stories.snapshot(story.id).tools.find(tool => tool.name === 'rp_commit_turn')?.status).toBe('running')
    expect(x.stories.hasCommitted(sent.body.run.id)).toBe(false)
    if (outcome === 'complete') release()
    else if (outcome === 'stop') await x.call(`/api/runs/${sent.body.run.id}/stop`, 'POST')
    else await x.queue.close()
    await x.queue.idle()
    const saved = x.stories.snapshot(story.id), commits = x.stories.eventsOfTypes(story.id, ['turn.committed'])
    expect(x.stories.eventsOfTypes(story.id, ['reply-options.ready', 'maintenance.status'])).toEqual([])
    expect(x.requests).toHaveLength(4)
    if (outcome === 'complete') {
      expect(commits).toHaveLength(1)
      expect(saved.messages.at(-1)?.text).toBe('等待选项后共同保存。')
      expect(saved.replyOptions[saved.messages.at(-1)!.id]).toEqual(['走向海边。'])
      expect(x.stories.run(sent.body.run.id).status).toBe('completed')
    } else {
      expect(commits).toEqual([]); expect(saved.replyOptions).toEqual({})
      expect(x.stories.run(sent.body.run.id)).toMatchObject({ status: outcome === 'stop' ? 'cancelled' : 'interrupted', draft: '等待选项后共同保存。' })
    }
  })

  it('recovers an interrupted run without repeating its model or tool calls and resumes only work that was still queued', async () => {
    const x = await setup([{ call: { name: 'rp_reply', arguments: { text: '这是新排队任务的普通回复。' } } }])
    const interrupted = x.service.create('待恢复故事'), queued = x.service.create('排队故事')
    const old = x.service.send(interrupted.id, 'interrupted', [{ text: '旧任务', attachmentIds: [] }]).run
    x.stories.setRunStatus(old.id, 'running'); x.stories.saveDraft(old.id, '已保留的草稿。')
    x.stories.append(interrupted.id, { type: 'tool.started', data: { callId: 'old-side-effect', runId: old.id, name: 'bash', arguments: { command: 'side effect' }, status: 'running' } })
    const waiting = x.service.send(queued.id, 'queued', [{ text: '新任务', attachmentIds: [] }]).run
    await x.app.close()
    const restarted = await createServer(x.config, { modelOptions: x.modelOptions }); cleanup.push(() => restarted.app.close())
    await restarted.app.ready(); await restarted.queue.idle()
    expect(restarted.stories.run(old.id)).toMatchObject({ status: 'interrupted', draft: '已保留的草稿。' })
    expect(restarted.stories.snapshot(interrupted.id).tools[0]?.status).toBe('interrupted')
    expect(restarted.stories.run(waiting.id).status).toBe('completed')
    expect(x.requests).toHaveLength(1); expect(JSON.stringify(x.requests)).toContain('新任务'); expect(JSON.stringify(x.requests)).not.toContain('旧任务')
    const login = await restarted.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password } })
    expect(login.statusCode).toBe(200)
  })
})
