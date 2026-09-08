/** Isolated browser fixture: real application/Pi/tools, synthetic provider responses, temporary data only. */
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { createServer as createNetServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../../apps/server/src/server.ts'
import { createToolServer } from '../../apps/tools/src/server.ts'
import { SUMMARY_HEADINGS, SUMMARY_INSTRUCTION } from '../../packages/rp-core/src/context/summary.ts'
import { browserScenario } from './scenario.ts'
import { seedTrajectoryMutations } from './trajectory-mutations-fixture.ts'
import { seedTrajectoryScenario } from './trajectory-fixture.ts'
import { streamingTextResponse } from '../streaming-response.ts'
import { seedConversationBoundaries } from './boundary-fixture.ts'
import { activityResponse } from './activity-response.ts'

const persistentRoot = process.env.RP_BROWSER_FIXTURE_ROOT
const root = persistentRoot ? resolve(persistentRoot) : await mkdtemp(join(tmpdir(), 'rp-browser-fixture-')), inputs = join(root, 'data/inputs'), skills = join(root, 'skills'), workspaces = join(root, 'workspaces')
await Promise.all([inputs, skills, workspaces].map(directory => mkdir(directory, { recursive: true })))
const sessionKeyPath = join(root, 'session_key')
let sessionKey: Buffer
try { sessionKey = await readFile(sessionKeyPath) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; sessionKey = randomBytes(32); await writeFile(sessionKeyPath, sessionKey, { mode: 0o600, flag: 'wx' }) }
const allowClinePass = process.env.RP_BROWSER_ALLOW_CLINEPASS === '1'
const activityPreview = process.env.RP_BROWSER_ACTIVITY_TEST === '1'
const requestedPort = Number(process.env.RP_BROWSER_FIXTURE_PORT ?? 0)
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535 || requestedPort === 3080) throw new Error('Invalid independent browser fixture port')
const reserve = createNetServer(); await new Promise<void>(resolve => reserve.listen(requestedPort, '127.0.0.1', resolve))
const port = (reserve.address() as { port: number }).port; await new Promise<void>((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()))
const origin = `http://127.0.0.1:${port}`, token = randomBytes(32).toString('base64url')
const tools = createToolServer({ token, roots: { inputs, workspaces, skills } })
const toolsUrl = await tools.app.listen({ host: '127.0.0.1', port: 0 })
const route = { provider: 'browser-fixture', model: 'test-model' }, password = 'browser-test-password-2026'
const writerResponse = '请先确认故事发生的地点，再继续写作。'
const narrative = '雨停的时候，灯塔里的钟响了三下。\n\n林舟把湿透的外套搭在椅背上，抬头看见桌边的人。她没有问他的来意，只将那封已经拆开的信推到灯下。\n\n“你也收到了一封，对吗？”\n\n窗外的海面正慢慢暗下去。林舟没有立即回答。他从口袋里取出另一只信封——同样的蓝色邮戳，同样没有署名。两封信并排放着，像一段终于找到另一半的旧事。\n\n他拉开椅子，坐了下来。\n\n“从头说吧。”'
const app = await createServer({ dataDirectory: join(root, 'data'), publicOrigin: origin, sessionKey, tools: { url: toolsUrl, token },
  models: [route, { provider: route.provider, model: 'test-vision-model' }].map(model => ({ ...model, keyEnv: 'SYNTHETIC_BROWSER_KEY', api: 'openai-completions' as const, baseUrl: 'https://synthetic.invalid/v1', contextWindow: 128000, maxTokens: 8192, input: model.model.includes('vision') ? ['text', 'image'] : ['text'] })), defaultMain: route,
  skillRoots: [{ path: resolve('skills/builtin'), virtualPath: '/skills/builtin' }, { path: skills, virtualPath: '/skills/custom' }], webDirectory: resolve(process.env.RP_BROWSER_WEB_DIRECTORY ?? 'apps/web/dist'),
}, { modelOptions: { env: name => name === 'SYNTHETIC_BROWSER_KEY' ? 'browser-fixture-secret' : undefined, fetch: async (url, init) => {
  if (String(url).startsWith('https://synthetic.invalid/')) {
    const auth = new Headers(init?.headers).get('authorization')
    if (auth === 'Bearer browser-invalid-key') return Response.json({ error: { message: 'Invalid API key' } }, { status: 401 })
    if (init?.method === 'GET') return Response.json({ data: [{ id: 'test-model', name: 'Synthetic Text' }, { id: 'test-vision-model', name: 'Synthetic Vision' }, { id: 'test-reasoning-model', name: 'Synthetic Reasoning' }, { id: 'gpt-6-astra', name: 'GPT-6 Astra · 合成验收' }] })
  }
  if (!String(url).startsWith('https://synthetic.invalid/')) {
    const request = JSON.parse(String(init?.body)) as { model?: string }
    if (!allowClinePass || String(url) !== 'https://api.cline.bot/api/v1/chat/completions' || request.model !== 'cline-pass/deepseek-v4-flash') throw new Error('Live provider is not enabled for this browser fixture')
    const response = await fetch(url, init)
    await appendFile(join(root, 'clinepass-requests.jsonl'), JSON.stringify({ time: new Date().toISOString(), model: request.model, status: response.status }) + '\n', { mode: 0o600 })
    return response
  }
  const body = JSON.parse(String(init?.body)) as { messages: { role: string; content?: unknown; name?: string; tool_calls?: unknown[] }[]; tools?: { function: { name: string; parameters?: { anyOf?: { required?: string[] }[] } } }[] }
  const names = body.tools?.map(tool => tool.function.name) ?? [], system = JSON.stringify(body.messages.filter(message => message.role === 'system')), last = body.messages.at(-1)
  let text = '', call: { name: string; args: object } | undefined
  if (system.includes(SUMMARY_INSTRUCTION.slice(0, 25))) {
    if (body.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('BROWSER_SUMMARY_DELAY_TEST'))) await pause(10000, undefined, { signal: init?.signal ?? undefined })
    text = SUMMARY_HEADINGS.map(heading => `${heading}\n- 林舟来到灯塔，与一位同样收到匿名信的女人会面。`).join('\n\n')
  }
  else if (names.includes('rp_write_turn')) {
    const scenario = browserScenario(body.messages)
    const performed = body.messages.flatMap(message => (message.tool_calls ?? []).map(call => (call as { function: { name: string } }).function.name))
    if (last?.role === 'user' && scenario.has('BROWSER_DELAY_TEST')) await pause(10000, undefined, { signal: init?.signal ?? undefined })
    if (last?.role === 'tool' && performed.includes('rp_write_turn')) {
      if (activityPreview && scenario.has('BROWSER_STREAM_TEST') || scenario.has('BROWSER_COMMIT_DELAY_TEST')) await pause(10000, undefined, { signal: init?.signal ?? undefined })
      call = JSON.stringify(last.content).includes(writerResponse)
        ? { name: 'rp_reply', args: { useWriterResult: true } }
        : { name: 'rp_commit_turn', args: { runSummary: '林舟在灯塔中与神秘来信的另一位收件人见面。',
          ...(!system.includes('Reply options are disabled.') ? { extensions: { 'rp.reply-options': { options: scenario.has('BROWSER_REPLY_OPTIONS_INVALID_TEST') ? [] : ['请她先讲述信中的内容。', '比较两封信的邮戳与字迹。', '起身查看窗外是谁来了。'] } } } : {}),
        } }
    }
    else if (last?.role === 'user' && names.includes('ask_user_question') && scenario.has('出发前，让我们确认一下计划。')) call = { name: 'ask_user_question', args: { questions: [
      { id: 'direction', question: '接下来先调查哪里？', options: [{ label: '塔顶', description: '检查钟楼与灯室。' }, { label: '码头', description: '打听寄信人的去向。' }] },
      { id: 'supplies', question: '想带上哪些东西？', multi_select: true, options: [{ label: '旧海图', description: '上面标着一条被遗忘的航线。' }, { label: '手电筒', description: '灯塔的楼梯间没有灯。' }, { label: '那封信' }] },
      { id: 'note', question: '还有什么想告诉青禾？', options: [] },
    ] } }
    else if (last?.role === 'user' && names.includes('ask_user_question') && (scenario.has('BROWSER_ASK_TEST') || scenario.has('我们接下来去哪里？'))) call = { name: 'ask_user_question', args: { questions: [{ id: 'direction', question: '接下来先调查哪里？', options: [{ label: '塔顶', description: '检查钟楼与灯室。' }, { label: '码头', description: '打听寄信人的去向。' }] }] } }
    else if (last?.role === 'user' && names.includes('read') && scenario.has('BROWSER_WORKSPACE_READ_TEST')) call = { name: 'read', args: { file_path: 'lighthouse.txt' } }
    else if (last?.role === 'user' && names.includes('bash') && scenario.has('BROWSER_TOOL_TEST')) call = { name: 'bash', args: { command: 'printf "灯塔工作笔记\\n" > lighthouse.txt; cat lighthouse.txt' } }
    else if (last?.role === 'user' && names.includes('bash') && scenario.has('BROWSER_TOOL_LIMIT_TEST')) call = { name: 'bash', args: { command: 'printf "%0200d" 0' } }
    else if (last?.role === 'user' && names.includes('bash') && scenario.has('BROWSER_TOOL_TIMEOUT_TEST')) call = { name: 'bash', args: { command: 'printf "开始检查\\n"; sleep 10' } }
    else if (last?.role === 'user' && names.includes('web_search') && scenario.has('BROWSER_SEARCH_TEST')) call = { name: 'web_search', args: { query: '海边灯塔的历史' } }
    else call = { name: 'rp_write_turn', args: { action: 'write' } }
    if (call.name === 'rp_commit_turn' && scenario.has('BROWSER_STATE_TEST')) {
      call.args = { ...call.args, effects: [{ kind: 'state.update', namespace: 'story', expectedRevision: scenario.stateRevision(), payload: { changes: [{ op: 'increment', path: '/energy', by: -1, reason: '调查灯塔消耗精力' }] } }] }
    }
    if (call.name === 'rp_commit_turn' && body.tools?.find(tool => tool.function.name === 'rp_commit_turn')?.function.parameters?.anyOf?.some(schema => schema.required?.includes('narrative'))) call.args = { ...call.args, narrative }
  } else text = last?.content === 'Reply with OK.' ? 'OK'
    : browserScenario(body.messages).has('BROWSER_WRITER_RESPONSE_TEST') ? writerResponse : narrative
  const draftVisibility = browserScenario(body.messages).has('BROWSER_DRAFT_VISIBILITY_TEST')
  const liveActivity = browserScenario(body.messages).has('BROWSER_LIVE_ACTIVITY_TEST')
  if (liveActivity && (call?.name === 'rp_write_turn' || call?.name === 'rp_commit_turn')) return activityResponse(call.name === 'rp_write_turn'
    ? '我会先核对这一轮的角色与场景资料，确认灯塔来信的线索和人物关系。接下来请 Writer 延续两封信的情节，保持人物语气一致，再检查正文与剧情状态。'
    : 'Writer 已完成这一段。我正在核对两封信的线索与人物关系，随后保存正文和剧情状态。', call, init?.signal)
  if (draftVisibility && call?.name === 'rp_write_turn') text = '正在检查写作要求，随后调用 Writer。'
  if (draftVisibility && call?.name === 'rp_commit_turn') text = '已审阅，准备提交这轮正文。'
  if (!call && text === narrative && (draftVisibility || liveActivity || browserScenario(body.messages).has('BROWSER_STREAM_TEST'))) {
    if (draftVisibility) await pause(8000, undefined, { signal: init?.signal ?? undefined })
    return streamingTextResponse(text, init?.signal)
  }
  const delta = { role: 'assistant', content: text, ...(call ? { tool_calls: [{ index: 0, id: randomBytes(6).toString('hex'), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) }
  return new Response(`data: ${JSON.stringify({ id: randomBytes(6).toString('hex'), choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
} }, searchFetch: async (url, init) => {
  if (String(url) !== 'https://synthetic-search.invalid/anthropic/messages') throw new Error('Only the synthetic search endpoint is enabled in this browser fixture')
  const key = new Headers(init?.headers).get('x-api-key') ?? ''
  if (!key.startsWith('browser-search-test-')) return Response.json({ error: 'Synthetic search key rejected' }, { status: 401 })
  const body = JSON.parse(String(init?.body))
  await appendFile(join(root, 'search-requests.jsonl'), JSON.stringify({ time: new Date().toISOString(), model: body.model, maxUses: body.tools?.[0]?.max_uses, authenticated: true }) + '\n')
  return Response.json({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.test/lighthouse', title: '原创灯塔搜索测试资料' }] }] })
} })
if (!app.auth.configured()) await app.auth.setPassword(password)
app.app.addHook('onRequest', async request => {
  if (request.url.startsWith('/api/')) await appendFile(join(root, 'auth-diagnostics.jsonl'), JSON.stringify({ time: new Date().toISOString(), path: request.url.split('?')[0], cookiePresent: Object.keys(request.cookies).some(name => name.startsWith('rp_session_')), sessionPresent: Boolean(request.session?.get('adminEpoch')), authenticated: request.session?.get('adminEpoch') === app.auth.epoch() }) + '\n')
})
const existing = app.stories.list()[0]
let storyId = existing?.id
if (!existing) {
const card = app.assets.create('character', { name: '沈青禾', description: '海边灯塔的守灯人，沉静而敏锐。', personality: '寡言，细心，总会为来客留一盏灯。', firstMessage: '灯塔的门虚掩着，桌上放着一封未署名的信。', scenario: '一座被海雾包围的老灯塔。', creatorNotes: '浏览器验收使用的原创合成角色。' })
app.assets.create('persona', { name: '林舟', description: '追寻一封来历不明的信，回到离别已久的海岸。' })
const book = app.assets.create('lorebook', { name: '雾港档案', entries: [{ id: 'lighthouse', name: '旧灯塔', content: '灯塔位于海岸最北端，每天黄昏响钟三次。', level: 'worldDescription', constant: true, enabled: true }] })
const story = app.service.create('灯塔来信', { resources: { card: { id: card.id }, lorebooks: [{ id: book.id }], writingStyles: [] }, scene: { openingSource: 'card', openingIndex: 0 } })
app.service.create('雨夜旧车站'); app.service.create('第二次相遇')
storyId = story.id
app.service.send(story.id, 'fixture-first', [{ text: '我推开灯塔的门，把信封放在桌上。', attachmentIds: [] }])
}
await app.app.listen({ host: '127.0.0.1', port })
app.queue.wake(); await app.queue.idle()
if (process.env.RP_BROWSER_TRACE_MUTATIONS === '1') await seedTrajectoryMutations(app)
if (process.env.RP_BROWSER_TRACE_SCENARIO === '1') seedTrajectoryScenario(app)
const boundaryCases = process.env.RP_BROWSER_BOUNDARY_SCENARIO === '1' ? await seedConversationBoundaries(app) : undefined
process.stdout.write(JSON.stringify({ url: origin, password, storyId, root, pid: process.pid, providerPolicy: allowClinePass ? 'synthetic fixture plus explicitly enabled ClinePass' : 'synthetic only', persistent: Boolean(persistentRoot), boundaryCases }) + '\n')
let closing = false
async function close() { if (closing) return; closing = true; await app.app.close(); await tools.app.close(); if (!persistentRoot) await rm(root, { recursive: true, force: true }) }
process.once('SIGINT', () => { void close().then(() => process.exit(0)) }); process.once('SIGTERM', () => { void close().then(() => process.exit(0)) })
