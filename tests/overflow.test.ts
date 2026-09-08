import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { SummaryService } from '../apps/server/src/services/summary-service.ts'
import { RunExecutor, type ExecutionResources } from '../apps/server/src/runtime/executor.ts'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { SUMMARY_HEADINGS } from '../packages/rp-core/src/context/summary.ts'
import { fixture, message, profile } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
const route = { provider: 'synthetic', model: 'overflow' }
const summary = SUMMARY_HEADINGS.map(heading => heading + '\n- 故事发生在海边。').join('\n\n')
type Reply = 'overflow' | { text?: string; tool?: string; args?: object }
function response(reply: Reply, index: number) {
  if (reply === 'overflow') return new Response(JSON.stringify({ error: { message: 'maximum context length is 100000 tokens, however you requested 100500 tokens', type: 'invalid_request_error', code: 'context_length_exceeded' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  return new Response(`data: ${JSON.stringify({ id: `response-${index}`, choices: [{ index: 0, delta: { role: 'assistant', content: reply.text ?? '', ...(reply.tool ? { tool_calls: [{ index: 0, id: `tool-${index}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }] } : {}) }, finish_reason: reply.tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}
function setup(replies: Reply[]) {
  const x = fixture(), configuration = profile(); configuration.runtime.executionMode = 'agent'
  const card = x.assets.create('character', { name: 'FROZEN_NAME', description: 'FROZEN_CARD_FACT' })
  configuration.resources.card = { id: card.id }
  const story = x.stories.create('上下文恢复', configuration), service = new StoryService(x.stories, x.assets, x.files)
  for (const item of [message('user', '海岸上有许多往事。'.repeat(500), { turnId: 'old' }), message('assistant', '旅人正在寻找灯塔。'.repeat(500), { turnId: 'old', kind: 'narrative' }),
    message('user', '最近请求', { turnId: 'recent' }), message('assistant', '最近的完整回复。', { turnId: 'recent', kind: 'narrative' })]) x.stories.append(story.id, { type: 'message.added', data: { message: item } })
  const requests: Record<string, unknown>[] = [], faults: unknown[] = []
  const models = new ModelRegistry([{ ...route, keyEnv: 'MODEL_KEY', api: 'openai-completions', baseUrl: 'https://model.test/v1', contextWindow: 128000, maxTokens: 8192 }], {
    env: () => 'synthetic-key', fetch: async (_url, init) => {
      const index = requests.length, reply = replies[index]; requests.push(JSON.parse(String(init?.body)))
      if (!reply) throw new Error('Unexpected provider request')
      if (reply !== 'overflow' && reply.text === summary) x.assets.update(card.id, card.revision, { ...card.data, name: 'LIVE_EDIT', description: 'LIVE_EDIT_MUST_NOT_ENTER_CURRENT_CONTEXT' })
      return response(reply, index)
    },
  })
  const summaries = new SummaryService(x.stories, models, error => faults.push(error))
  const executor = new RunExecutor(x.stories, new ContextService(x.stories, x.assets), new TurnService(x.stories), models, x.files, summaries)
  const resources: ExecutionResources = { routes: { main: route, writer: route }, files: [], images: [], specialists: [], readonlyTools: [], tools: () => [] }
  const run = service.send(story.id, 'current', [{ text: 'CURRENT_INPUT_REMAINS', attachmentIds: [] }]).run
  const queue = new RunQueue(x.stories, (id, signal) => executor.execute(id, signal, resources), error => faults.push(error))
  cleanup.push(async () => { await queue.close(); await summaries.close(); x.close(); expect(faults).toEqual([]) })
  return { ...x, storyId: story.id, run, resources, requests, queue, summaries }
}
const write: Reply = { tool: 'rp_write_turn', args: { action: 'write' } }
const commit: Reply = { tool: 'rp_commit_turn', args: { narrative: '最终正文。' } }

describe('bounded Pi context overflow continuation', () => {
  it('keeps completed side effects and the Writer result while retrying only a failed parent request', async () => {
    const x = setup([{ tool: 'append_file' }, write, { text: 'Writer 已完成的正文。' }, 'overflow', { text: summary }, commit])
    const filename = join(x.directory, 'side-effect.txt')
    x.resources.tools = () => [{ name: 'append_file', label: '记录', description: '向文件追加记录', parameters: Type.Object({}), execute: async () => {
      appendFileSync(filename, 'once\n'); return { content: [{ type: 'text', text: 'FILE_WAS_APPENDED' }], details: {} }
    } }]
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id)).toMatchObject({ status: 'completed' })
    expect(readFileSync(filename, 'utf8')).toBe('once\n')
    const records = x.stories.eventLog(x.storyId), resumed = JSON.stringify(x.requests[5])
    expect(records.filter(event => event.type === 'writer.completed')).toHaveLength(1)
    expect(records.filter(event => event.type === 'context.built')).toHaveLength(1)
    expect(records.filter(event => event.type === 'context.compacted')).toHaveLength(1)
    expect(resumed).toContain('FILE_WAS_APPENDED'); expect(resumed).toContain('Writer 已完成的正文')
    expect(resumed).toContain('FROZEN_CARD_FACT'); expect(resumed).not.toContain('LIVE_EDIT_MUST_NOT_ENTER_CURRENT_CONTEXT')
    expect(resumed).toContain('CURRENT_INPUT_REMAINS'); expect(resumed).not.toContain('海岸上有许多往事。'.repeat(5))
    expect(x.stories.snapshot(x.storyId).messages.at(-1)?.text).toBe('最终正文。')
    expect(records.filter(event => event.type === 'turn.committed')).toHaveLength(1)
  })

  it('continues an overflowing Writer without redoing its read tools, then freezes and commits that exact Chat text', async () => {
    const x = setup([write, { tool: 'read' }, 'overflow', { text: summary }, { text: 'Writer 压缩后完成。' }, { tool: 'rp_commit_turn' }])
    const snapshot = x.stories.snapshot(x.storyId); snapshot.profile.runtime.executionMode = 'chat'
    x.stories.append(x.storyId, { type: 'profile.changed', data: { profile: snapshot.profile } })
    let reads = 0
    x.resources.readonlyTools = [{ name: 'read', label: '读取', description: '读取文件', parameters: Type.Object({}), execute: async () => {
      reads++; return { content: [{ type: 'text', text: 'READ_TOOL_RESULT_PRESERVED' }], details: {} }
    } }]
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('completed'); expect(reads).toBe(1)
    expect(x.requests).toHaveLength(6)
    expect(JSON.stringify(x.requests[4])).toContain('READ_TOOL_RESULT_PRESERVED')
    expect(JSON.stringify(x.requests[4])).toContain('CURRENT_INPUT_REMAINS')
    expect(JSON.stringify(x.requests[4])).toContain('Newer Conversation History takes precedence.')
    expect(JSON.stringify(x.requests[4])).toContain('This original text takes precedence over Conversation Summary.')
    expect(JSON.stringify(x.requests[4])).not.toContain('LIVE_EDIT_MUST_NOT_ENTER_CURRENT_CONTEXT')
    expect(x.stories.snapshot(x.storyId).messages.at(-1)?.text).toBe('Writer 压缩后完成。')
    const records = x.stories.eventLog(x.storyId)
    expect(records.filter(event => event.type === 'context.built')).toHaveLength(2)
    expect(records.filter(event => event.type === 'writer.completed')).toHaveLength(1)
  })

  it('stops after one failed overflow recovery without a loop or narrative commit', async () => {
    const x = setup(['overflow', { text: summary }, 'overflow'])
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(x.run.id)).toMatchObject({ status: 'failed', error: { code: 'CONTEXT_OVERFLOW' } })
    expect(x.requests).toHaveLength(3)
    expect(x.stories.eventLog(x.storyId).filter(event => event.type === 'turn.committed')).toHaveLength(0)
  })
})
