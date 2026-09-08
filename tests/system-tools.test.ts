import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { FileService } from '../apps/server/src/services/file-service.ts'
import { QuestionService } from '../apps/server/src/services/question-service.ts'
import { SkillService } from '../apps/server/src/services/skill-service.ts'
import { TraceService } from '../apps/server/src/services/trace-service.ts'
import { SubagentService } from '../apps/server/src/services/subagent-service.ts'
import { ResourceFactory } from '../apps/server/src/runtime/resources.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { RunExecutor } from '../apps/server/src/runtime/executor.ts'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import { DeepSeekSearch } from '../apps/server/src/runtime/search.ts'
import { SystemTools } from '../apps/server/src/runtime/system-tools.ts'
import { ToolClient } from '../apps/server/src/runtime/tool-client.ts'
import { createToolServer } from '../apps/tools/src/server.ts'
import type { ExecutionMode, JsonObject, StoryProfile } from '../packages/rp-core/src/types.ts'
import { fixture, profile } from './helpers.ts'
import { WriterHistoryService } from '../apps/server/src/services/writer-history-service.ts'
import { historyConfig } from './writer-history-fixture.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
type Reply = { text?: string; calls?: { name: string; arguments: object }[] }

async function setup(mode: ExecutionMode, replies: Reply[], attachment?: 'image' | 'text', options: { skillFixture?: boolean; tasks?: boolean; identity?: string; writerHistory?: boolean; storyRoutes?: (ids: Record<string, string>) => Partial<StoryProfile['runtime']> } = {}) {
  const x = fixture(), config = profile(); config.runtime.executionMode = mode
  await mkdir(join(x.directory, 'workspaces')); await mkdir(join(x.directory, 'skills'))
  await cp(fileURLToPath(new URL('../skills/builtin', import.meta.url)), join(x.directory, 'skills/builtin'), { recursive: true })
  if (options.skillFixture) {
    await mkdir(join(x.directory, 'skills/blueprint/references'), { recursive: true })
    await writeFile(join(x.directory, 'skills/blueprint/SKILL.md'), '---\nname: blueprint\ndescription: 检查故事附件并生成工作文件。\n---\nRead references/details.md, then run collect.sh with the attachment path. The script writes notes.txt in the story workspace.')
    await writeFile(join(x.directory, 'skills/blueprint/references/details.md'), '保留附件的原始文字，追加计划完成标记。')
    await writeFile(join(x.directory, 'skills/blueprint/collect.sh'), 'cat "$1" > notes.txt\nprintf "\\n计划完成" >> notes.txt\n')
  }
  const token = 'synthetic-system-tools-0123456789abcdef'
  const server = createToolServer({ token, roots: { workspaces: join(x.directory, 'workspaces'), inputs: x.files.directory, skills: join(x.directory, 'skills') } })
  cleanup.push(async () => { await server.app.close(); x.close() })
  const url = await server.app.listen({ host: '127.0.0.1', port: 0 })
  let story = x.stories.create('模型工具链', config)
  const files = new FileService(x.files, x.assets, x.stories), questions = new QuestionService(x.stories)
  const file = attachment ? await files.upload(attachment === 'image' ? await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff8000' } }).png().toBuffer() : Buffer.from('附件中的地点是北塔。'), attachment === 'image' ? 'test.png' : 'notes.txt', attachment === 'image' ? 'image/png' : 'text/plain') : undefined
  const requests: JsonObject[] = []
  const hooks: { onRequest?: (index: number) => void } = {}
  const taskIds: Record<string, string> = {}
  const route = { provider: 'test', model: 'rp-tools' }
  const models = new ModelRegistry([{ ...route, keyEnv: 'SYNTHETIC_MODEL_KEY', api: 'openai-completions', baseUrl: 'https://model.test/v1', input: ['text', 'image'], contextWindow: 100000, maxTokens: 8000 }], {
    env: () => 'synthetic-model-key', fetch: async (_url, init) => {
      const index = requests.length; requests.push(JSON.parse(String(init?.body)))
      hooks.onRequest?.(index)
      const next = replies[index]
      if (!next) throw new Error('Unexpected provider request')
      const delta = { role: 'assistant', content: next.text ?? '', ...(next.calls ? { tool_calls: next.calls.map((call, order) => ({ index: order, id: `call-${index}-${order}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments).replaceAll('INPUT_FILE', file?.storageKey ?? '').replaceAll('SKILL_ROOT', join(x.directory, 'skills')).replaceAll('INPUT_ROOT', x.files.directory).replaceAll('PLAN_ID', taskIds['规划'] ?? '').replaceAll('POLISH_ID', taskIds['润色'] ?? '') } })) } : {}) }
      return new Response(`data: ${JSON.stringify({ id: `reply-${index}`, choices: [{ index: 0, delta, finish_reason: next.calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const search = new DeepSeekSearch(() => ({ baseUrl: 'https://search.test/anthropic/v1', model: 'native-search', keyEnv: 'SYNTHETIC_SEARCH_KEY' }), {
    env: () => 'synthetic-search-key', fetch: async () => Response.json({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.test/source', title: '搜索来源' }] }] }),
  })
  const system = new SystemTools(new ToolClient(url, token), files, questions, search)
  const turns = new TurnService(x.stories), subagents = new SubagentService(x.assets, models)
  for (const subagent of subagents.snapshot().subagents) taskIds[subagent.name] = subagent.id
  const service = new StoryService(x.stories, x.assets, x.files)
  if (options.storyRoutes) story = service.updateProfile(story.id, story.revision, { ...story.profile, runtime: { ...story.profile.runtime, ...options.storyRoutes(taskIds) } })
  const run = service.send(story.id, 'system-tools', [{ text: '请检查工具和资料，然后告诉我结果。', attachmentIds: file ? [file.id] : [] }]).run
  const history = new WriterHistoryService(x.assets)
  if (options.writerHistory) history.update(1, historyConfig())
  const resources = new ResourceFactory(new StoryService(x.stories, x.assets, x.files), turns, system, models,
    new SkillService([{ path: join(x.directory, 'skills'), virtualPath: '/skills' }]), subagents, route, { skills: true, disabledSkills: [], subagents: options.tasks === true, identity: options.identity, writerHistory: history.capture() })
  const executor = new RunExecutor(x.stories, new ContextService(x.stories, x.assets), turns, models, x.files)
  const faults: unknown[] = []
  const queue = new RunQueue(x.stories, async (id, signal) => {
    return executor.execute(id, signal, await resources.prepare(id, signal))
  }, error => faults.push(error))
  return { ...x, story, run, file, questions, queue, requests, faults, subagents, models, hooks }
}

describe('Pi with concrete system tools', () => {
  it('injects history into Writer only while task agents keep fresh contexts and original read-only tools', async () => {
    const x = await setup('agent', [
      { calls: [{ name: 'rp_run_subagent', arguments: { subagent: 'PLAN_ID', task: '规划', input: {} } }] }, { text: '先核对灯塔记录。' },
      { calls: [{ name: 'rp_write_turn', arguments: { action: 'write' } }] }, { text: '她打开记录簿。' },
      { calls: [{ name: 'rp_run_subagent', arguments: { subagent: 'POLISH_ID', task: '校对', input: { draft: '她打开记录簿。' } } }] }, { text: '没有错字。' },
      { calls: [{ name: 'rp_commit_turn', arguments: { narrative: '她打开记录簿。' } }] },
    ], undefined, { tasks: true, writerHistory: true })
    x.queue.wake(); await x.queue.idle()
    expect(x.faults).toEqual([])
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(x.requests).toHaveLength(7)
    expect(JSON.stringify(x.requests[3])).toContain('900719925474099312345')
    for (const index of [0, 1, 2, 4, 5, 6]) expect(JSON.stringify(x.requests[index])).not.toContain('900719925474099312345')
    const tools = (x.requests[3]!.tools as unknown as { function: { name: string } }[]).map(tool => tool.function.name)
    expect(tools).toEqual(['read', 'read_image'])
    const logged = new TraceService(x.stories).run(x.run.id)
    expect(logged.tools.map(tool => tool.name)).toEqual(['rp_run_subagent', 'rp_write_turn', 'rp_run_subagent', 'rp_commit_turn'])
    await x.queue.close()
  })
  it('uses independently saved story models for planning, Writer and polishing in actual provider requests', async () => {
    const fixed = (model: string) => ({ kind: 'fixed' as const, provider: 'test', model })
    const x = await setup('agent', [
      { calls: [{ name: 'rp_run_subagent', arguments: { subagent: 'PLAN_ID', task: '规划', input: {} } }] }, { text: '先读信，再回应。' },
      { calls: [{ name: 'rp_write_turn', arguments: { action: 'write', brief: '先读信，再回应。' } }] }, { text: '她展开来信，低声回应。' },
      { calls: [{ name: 'rp_run_subagent', arguments: { subagent: 'POLISH_ID', task: '润色', input: { draft: '她展开来信，低声回应。' } } }] }, { text: '她展开来信，轻声答应。' },
      { calls: [{ name: 'rp_commit_turn', arguments: { narrative: '她展开来信，轻声答应。' } }] },
    ], undefined, { tasks: true, storyRoutes: ids => ({ writerRoute: fixed('story-writer'),
      subagentRoutes: { [ids['规划']!]: fixed('story-plan'), [ids['润色']!]: fixed('story-polish') } }) })
    x.models.replace([...x.models.registrations(), ...['story-writer', 'story-plan', 'story-polish'].map(model => ({ ...x.models.registrations()[0]!, model }))])
    const catalog = x.subagents.snapshot()
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(x.requests.map(request => request.model)).toEqual(['rp-tools', 'story-plan', 'rp-tools', 'story-writer', 'rp-tools', 'story-polish', 'rp-tools'])
    expect(x.stories.snapshot(x.story.id).messages.find(item => item.kind === 'narrative')?.text).toBe('她展开来信，轻声答应。')
    expect(x.subagents.snapshot()).toEqual(catalog)
    expect(x.faults).toEqual([])
  })

  it('does not advertise automatic selection and rejects per-call model overrides before any child request', async () => {
    const x = await setup('agent', [
      { calls: [{ name: 'rp_run_subagent', arguments: { subagent: 'PLAN_ID', task: '检查材料。', input: {}, model: { provider: 'test', model: 'not-authorized' } } }] },
      { text: '未经授权的选模已拒绝。' },
    ], undefined, { tasks: true })
    x.queue.wake(); await x.queue.idle()
    expect(x.requests).toHaveLength(2)
    expect(JSON.stringify(x.requests[0])).not.toContain('authorizedModels')
    const task = (x.requests[0]!.tools as { function: { name: string; parameters: { properties: object; additionalProperties: boolean } } }[]).find(tool => tool.function.name === 'rp_run_subagent')!
    expect(task.function.parameters.properties).not.toHaveProperty('model')
    expect(task.function.parameters.additionalProperties).toBe(false)
    expect(x.requests.every(request => request.model === 'rp-tools')).toBe(true)
    expect(x.stories.run(x.run.id).status).toBe('completed')
  })
  it('prunes a large Bash result in the next provider request while keeping the original tool record', async () => {
    const x = await setup('agent', [{ calls: [{ name: 'bash', arguments: { command: 'printf "%016000d" 0' } }] }, { text: '工具输出已检查。' }])
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    const sent = (x.requests[1]?.messages as JsonObject[]).find(message => message.role === 'tool')!
    expect(JSON.stringify(sent)).toContain('工具结果中段已省略')
    expect(JSON.stringify(sent).length).toBeLessThan(7000)
    const stored = x.stories.snapshot(x.story.id).tools.find(tool => tool.name === 'bash')!
    expect(JSON.stringify(stored.result).length).toBeGreaterThan(16000)
    expect(x.stories.eventLog(x.story.id).filter(event => event.type === 'model.message' && event.data.role === 'context:pruned')).toHaveLength(1)
  })

  it('refreshes the prepared request in place after consecutive material changes without retaining obsolete character context', async () => {
    const first = { action: 'update', kind: 'character', id: '', expectedRevision: 1, value: { description: 'FIRST_REPLACEMENT_DESCRIPTION' } }
    const second = { ...first, expectedRevision: 2, value: { description: 'FINAL_REPLACEMENT_DESCRIPTION' } }
    const x = await setup('agent', [
      { calls: [{ name: 'skill', arguments: { name: 'rp-guide-character-card' } }] },
      { calls: [{ name: 'rp_asset', arguments: first }] },
      { calls: [{ name: 'rp_asset', arguments: second }] },
      { calls: [{ name: 'rp_write_turn', arguments: { action: 'write' } }] },
      { text: '守塔人推开窗。' },
      { calls: [{ name: 'rp_commit_turn', arguments: { narrative: '守塔人推开窗。' } }] },
    ])
    const card = x.assets.create('character', { name: '守塔人', description: 'ORIGINAL_DESCRIPTION' })
    first.id = card.id; second.id = card.id
    const config = x.stories.snapshot(x.story.id).profile
    x.stories.append(x.story.id, { type: 'profile.changed', data: { profile: { ...config, revision: config.revision + 1, resources: { ...config.resources, card: { id: card.id } } } } })
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    const users = (x.requests[3]?.messages as JsonObject[]).filter(message => message.role === 'user')
    expect(users).toHaveLength(2)
    const prepared = users.filter(message => JSON.stringify(message.content).includes('<roleplay_request'))
    expect(prepared).toHaveLength(1)
    expect(JSON.stringify(prepared)).toContain('FINAL_REPLACEMENT_DESCRIPTION')
    expect(JSON.stringify(prepared)).not.toContain('FIRST_REPLACEMENT_DESCRIPTION')
    expect(JSON.stringify(prepared)).not.toContain('ORIGINAL_DESCRIPTION')
    expect(JSON.stringify(x.requests[4]?.messages)).toContain('FINAL_REPLACEMENT_DESCRIPTION')
  })

  it('runs the editable planning/Writer/polishing contracts with fresh task contexts and forwarded images', async () => {
    const x = await setup('agent', [
      { text: '父模型私有工作笔记。', calls: [{ name: 'rp_run_subagent', arguments: { subagent: 'PLAN_ID', task: '围绕塔门开启规划这一幕。', input: { goal: '观察塔内的人物' } } }] },
      { calls: [{ name: 'read_image', arguments: { file_path: '/inputs/INPUT_FILE' } }] },
      { text: '先让塔门打开，守塔人现身，停在其询问来意处。' },
      { calls: [{ name: 'rp_write_turn', arguments: { action: 'write', brief: '塔门打开，守塔人现身，询问来意后停下。' } }] },
      { text: '门开了。守塔人问：“你为何而来？”' },
      { calls: [{ name: 'rp_run_subagent', arguments: { subagent: 'POLISH_ID', task: '保留事件和对白含义，改善句子衔接。', input: { draft: '门开了。守塔人问：“你为何而来？”' } } }] },
      { text: '塔门缓缓打开，守塔人问：“你为何而来？”' },
      { calls: [{ name: 'rp_commit_turn', arguments: { narrative: '塔门缓缓打开，守塔人问：“你为何而来？”', runSummary: '守塔人询问来意。' } }] },
    ], 'image', { tasks: true, identity: '统一验收身份 {{model}}：准确执行当前职责。' })
    const original = x.subagents.snapshot().subagents[0]!
    x.hooks.onRequest = index => {
      if (index === 0) x.subagents.update(original.id, original.revision, { name: original.name, description: original.description, instructions: '下一轮才使用的新指令。', enabled: true, tools: [], route: original.route })
    }
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(x.requests).toHaveLength(8)
    const taskParameters = (x.requests[0]?.tools as { function: { name: string; parameters: { properties: { subagent: { enum: string[] } } } } }[]).find(tool => tool.function.name === 'rp_run_subagent')!.function.parameters
    expect(taskParameters.properties.subagent.enum).toEqual(x.subagents.snapshot().subagents.map(item => item.id))
    expect(taskParameters.properties.subagent.enum).not.toContain('规划')
    for (const request of x.requests) {
      const system = JSON.stringify((request.messages as JsonObject[]).filter(message => message.role === 'system'))
      expect(system).toContain('统一验收身份 rp-tools：准确执行当前职责。')
    }
    const taskInput = JSON.stringify(x.requests[1]?.messages)
    expect(taskInput).toContain('观察塔内的人物')
    expect(taskInput).toContain('current_attachments')
    expect(taskInput).not.toContain('父模型私有工作笔记')
    expect(taskInput).not.toContain('下一轮才使用的新指令')
    expect(JSON.stringify(x.requests[6]?.messages)).not.toContain('观察塔内的人物')
    const encodedImage = x.files.read(x.file!.id).bytes.toString('base64')
    expect(taskInput).toContain(encodedImage)
    expect(JSON.stringify(x.requests[6])).toContain(encodedImage)
    const story = x.stories.snapshot(x.story.id), nested = story.tools.find(tool => tool.name === 'read_image')!
    expect(nested.parentCallId).toBe(story.tools.find(tool => tool.name === 'rp_run_subagent')?.callId)
    expect(story.messages.filter(message => message.kind === 'narrative').map(message => message.text)).toEqual(['塔门缓缓打开，守塔人问：“你为何而来？”'])
    const journal = JSON.stringify(x.stories.eventLog(x.story.id))
    expect(journal).toContain('task:request')
    const trace = new TraceService(x.stories).run(x.run.id)
    expect(trace.requests).toHaveLength(8)
    expect(trace.requests.every(request => request.status === 'completed' && request.elapsedMs !== undefined)).toBe(true)
    expect(trace.requests.filter(request => request.parentCallId)).toHaveLength(4)
    expect(trace.tools.find(tool => tool.name === 'read_image')?.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(journal).not.toContain(encodedImage)
    expect(x.faults).toEqual([])
  })

  it('hides the task tool when every task subagent is disabled', async () => {
    const x = await setup('agent', [
      { calls: [{ name: 'rp_write_turn', arguments: { action: 'write' } }] },
      { text: '灯塔里亮起了灯。' },
      { calls: [{ name: 'rp_commit_turn', arguments: { narrative: '灯塔里亮起了灯。', runSummary: '灯亮了。' } }] },
    ], undefined, { tasks: true })
    for (const task of x.subagents.snapshot().subagents) x.subagents.setEnabled(task.id, task.revision, false)
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(JSON.stringify(x.requests[0]?.tools)).not.toContain('rp_run_subagent')
  })

  it('limits task tools and keeps child Skill loads from satisfying a parent mutation prerequisite', async () => {
    const x = await setup('agent', [
      { calls: [{ name: 'rp_run_subagent', arguments: { subagent: 'PLAN_ID', task: '检查变量指导和外部资料。', input: {} } }] },
      { calls: [{ name: 'skill', arguments: { name: 'rp-guide-state' } }] },
      { calls: [{ name: 'web_search', arguments: { query: '海岸资料' } }] },
      { text: '已检查变量指导和检索结果。' },
      { calls: [{ name: 'rp_state', arguments: { action: 'create', namespace: 'story', expectedRevision: 0, definition: { title: '计数', updateMode: 'schema-only', schema: { type: 'integer' }, rules: [] }, initialValue: 0 } }] },
      { text: '父模型还未加载变量指导，变量尚未创建。' },
    ], undefined, { tasks: true })
    const task = x.subagents.snapshot().subagents[0]!
    x.subagents.update(task.id, task.revision, { name: task.name, description: task.description, instructions: task.instructions, route: task.route, tools: ['skill', 'web_search'] })
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    const names = (x.requests[1]?.tools as JsonObject[]).map(tool => (tool.function as JsonObject).name)
    expect(names).toEqual(['read', 'read_image', 'skill', 'web_search'])
    const story = x.stories.snapshot(x.story.id)
    expect(story.state.namespaces).toEqual({})
    const stateCall = story.tools.find(tool => tool.name === 'rp_state')!
    expect(stateCall.status).toBe('failed')
    expect(JSON.stringify(stateCall.result)).toContain('SKILL_REQUIRED')
    expect(story.tools.filter(tool => tool.parentCallId).map(tool => tool.name)).toEqual(['skill', 'web_search'])
  })

  it('discovers a Skill, freezes its catalog, reads a reference and executes its script through the tool service', async () => {
    const x = await setup('agent', [
      { calls: [{ name: 'skill', arguments: { name: 'blueprint' } }] },
      { calls: [{ name: 'read', arguments: { file_path: '/skills/blueprint/references/details.md' } }] },
      { calls: [{ name: 'bash', arguments: { command: 'bash "SKILL_ROOT/blueprint/collect.sh" "INPUT_ROOT/INPUT_FILE"' } }] },
      { calls: [{ name: 'read', arguments: { file_path: 'notes.txt' } }] },
      { text: '已按 Skill 检查附件并生成工作文件。' },
    ], 'text', { skillFixture: true })
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    const tools = x.stories.snapshot(x.story.id).tools
    expect(tools.map(tool => [tool.name, tool.status])).toEqual([['skill', 'completed'], ['read', 'completed'], ['bash', 'completed'], ['read', 'completed']])
    expect(JSON.stringify(tools.at(-1)?.result)).toContain('附件中的地点是北塔。\\n计划完成')
    const context = x.stories.eventLog(x.story.id).find(event => event.type === 'context.built')
    expect(context?.data.systemPrompt).toContain('blueprint')
    expect(JSON.stringify(x.requests[1])).toContain('resourceBase')
    expect(x.faults).toEqual([])
  })

  it('runs Bash, reads its output file, asks a real pending question and uses native search', async () => {
    const x = await setup('agent', [
      { calls: [{ name: 'bash', arguments: { command: 'printf "%01000d" 0; printf "检查结果" > result.txt' } }] },
      { calls: [{ name: 'read', arguments: { file_path: 'result.txt' } }] },
      { calls: [{ name: 'ask_user_question', arguments: { questions: [{ id: 'next', question: '继续搜索吗？', options: [{ label: '继续', description: '检索参考资料' }, { label: '结束' }], multi_select: false }] } }] },
      { calls: [{ name: 'web_search', arguments: { query: '灯塔参考资料', max_results: 3 } }] },
      { text: '文件已检查，搜索来源也已找到。' },
    ])
    x.queue.wake()
    await expect.poll(() => x.stories.run(x.run.id).status).toBe('waiting_user')
    const question = x.stories.snapshot(x.story.id).questions[0]!
    x.questions.answer(x.story.id, question.id, [{ id: 'next', selected: ['继续'] }])
    await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    const snapshot = x.stories.snapshot(x.story.id)
    expect(snapshot.tools.map(tool => [tool.name, tool.status])).toEqual([['bash', 'completed'], ['read', 'completed'], ['ask_user_question', 'completed'], ['web_search', 'completed']])
    expect(snapshot.tools[0]?.output?.length).toBe(1000)
    expect(JSON.stringify(snapshot.tools[1]?.result)).toContain('检查结果')
    expect(JSON.stringify(snapshot.tools[3]?.result)).toContain('https://example.test/source')
    expect(snapshot.questions[0]?.status).toBe('answered')
    expect(JSON.stringify(x.stories.eventLog(x.story.id))).not.toContain('synthetic-search-key')
    expect(x.faults).toEqual([])
  })

  it('gives the model image bytes while every persisted model and tool image references an immutable file', async () => {
    const x = await setup('agent', [{ calls: [{ name: 'read_image', arguments: { file_path: '/inputs/INPUT_FILE' } }] }, { text: '图片已查看。' }], 'image')
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    const base64 = x.files.read(x.file!.id).bytes.toString('base64')
    expect(JSON.stringify(x.requests)).toContain(base64)
    const log = JSON.stringify(x.stories.eventLog(x.story.id))
    expect(log).not.toContain(base64)
    expect(log).toContain('image_reference')
    expect(log).toContain(x.file!.id)
    expect(x.database.sqlite.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 1 })
  })

  it('lets the isolated Writer read an attachment and nests its tool record under the Writer call', async () => {
    const x = await setup('chat', [
      { calls: [{ name: 'rp_write_turn', arguments: { action: 'write' } }] },
      { calls: [{ name: 'read', arguments: { file_path: '/inputs/INPUT_FILE' } }] },
      { text: '北塔的门缓缓打开。' },
      { calls: [{ name: 'rp_commit_turn', arguments: { runSummary: '来到北塔。' } }] },
    ], 'text')
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    const snapshot = x.stories.snapshot(x.story.id)
    const writer = snapshot.tools.find(tool => tool.name === 'rp_write_turn')!, read = snapshot.tools.find(tool => tool.name === 'read')!
    expect(read.parentCallId).toBe(writer.callId)
    expect(read.status).toBe('completed')
    expect(snapshot.messages.at(-1)?.text).toBe('北塔的门缓缓打开。')
    expect(JSON.stringify(x.requests[1]?.tools)).not.toContain('bash')
    expect(JSON.stringify(x.requests[0]?.tools)).not.toContain('ask_user_question')
  })

  it('refuses parent file mutations attempted by Writer and still permits reading before narrative completion', async () => {
    const x = await setup('agent', [
      { calls: [{ name: 'rp_write_turn', arguments: { action: 'write', brief: '只写来到北塔的正文；文件操作由父模型负责。' } }] },
      { calls: [{ name: 'bash', arguments: { command: 'printf leaked > forbidden.txt' } }] },
      { calls: [{ name: 'read', arguments: { file_path: '/inputs/INPUT_FILE' } }] },
      { text: '北塔的门缓缓打开。' },
      { calls: [{ name: 'rp_commit_turn', arguments: { narrative: '北塔的门缓缓打开。', runSummary: '来到北塔。' } }] },
    ], 'text')
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed')
    const snapshot = x.stories.snapshot(x.story.id)
    const writer = snapshot.tools.find(tool => tool.name === 'rp_write_turn')!
    const denied = snapshot.tools.find(tool => tool.name === 'bash')!
    expect(denied).toMatchObject({ parentCallId: writer.callId, status: 'failed' })
    expect(JSON.stringify(denied.result)).toContain('Tool bash not found')
    expect(snapshot.tools.find(tool => tool.name === 'read')).toMatchObject({ parentCallId: writer.callId, status: 'completed' })
    await expect(readFile(join(x.directory, 'workspaces', x.story.id, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(snapshot.messages.at(-1)?.text).toBe('北塔的门缓缓打开。')
  })
})

it('A08 exposes write and edit replace_all through the actual Pi loop and isolated tool RPC', async () => {
  const x = await setup('agent', [
    { calls: [{ name: 'write', arguments: { file_path: 'novel.txt', content: '第一稿' } }] },
    { calls: [{ name: 'write', arguments: { file_path: 'novel.txt', content: '海海' } }] },
    { calls: [{ name: 'edit', arguments: { file_path: 'novel.txt', old_string: '海', new_string: '塔', replace_all: true } }] },
    { calls: [{ name: 'read', arguments: { file_path: 'novel.txt' } }] },
    { text: '文件已改写。' },
  ])
  x.queue.wake(); await x.queue.idle()
  expect(x.stories.run(x.run.id).status).toBe('completed')
  expect(x.stories.snapshot(x.story.id).tools.map(tool => [tool.name, tool.status])).toEqual([['write', 'completed'], ['write', 'completed'], ['edit', 'completed'], ['read', 'completed']])
  expect(JSON.stringify(x.stories.snapshot(x.story.id).tools.at(-1)?.result)).toContain('塔塔')
})
