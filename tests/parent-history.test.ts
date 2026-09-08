import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Type } from '@earendil-works/pi-ai'
import { RunExecutor, type ExecutionResources } from '../apps/server/src/runtime/executor.ts'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { ModelHistoryService } from '../apps/server/src/services/model-history-service.ts'
import { StoryDeletionService } from '../apps/server/src/services/story-deletion-service.ts'
import { SidebarService } from '../apps/server/src/services/sidebar-service.ts'
import { parentMessages } from '../apps/server/src/runtime/parent-history.ts'
import { projectModelHistory } from '../packages/rp-core/src/story/model-history.ts'
import { fixture, message, profile } from './helpers.ts'

const clean: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of clean.splice(0)) await close() })
type Reply = { text?: string; calls?: { name: string; args: object }[] }
const call = (name: string, args = {}): Reply => ({ calls: [{ name, args }] })
const route = { provider: 'history-test', model: 'native-history' }
const textOf = (value: any): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(item => item.text ?? '').join('') : ''
function setup(mode: 'chat' | 'agent' = 'chat') {
  const x = fixture(), config = profile(); config.runtime.executionMode = mode
  const story = x.stories.create('原生历史', config), service = new StoryService(x.stories, x.assets, x.files)
  const replies: Reply[] = [], requests: Record<string, any>[] = [], faults: unknown[] = []
  const models = new ModelRegistry([{ ...route, keyEnv: 'KEY', api: 'openai-completions', baseUrl: 'https://fixture.test/v1', contextWindow: 128000, maxTokens: 8000, input: ['text', 'image'] }], {
    env: () => 'fixture-key', fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      const reply = replies.shift()
      if (!reply) throw new Error('Unexpected model request')
      // Deliberately reuse provider IDs in different requests/runs.
      const delta = { role: 'assistant', content: reply.text ?? '', ...(reply.calls ? { tool_calls: reply.calls.map((item, index) => ({
        index, id: `reused-call-${index}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) },
      })) } : {}) }
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reply.calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  let reads = 0
  const tools = [{ name: 'inspect_note', label: '读取', description: 'Read a note.', parameters: Type.Object({}), execute: async () => {
    reads++; return { content: [{ type: 'text' as const, text: 'NOTE_RESULT_原始记录' }], details: {} }
  } }]
  const resources: ExecutionResources = { routes: { main: route, writer: route }, files: [], images: [], specialists: [], readonlyTools: [], tools: () => tools,
    contextPolicy: { identity: 'HEADER_ORIGINAL' } }
  const history = new ModelHistoryService(x.stories)
  const executor = new RunExecutor(x.stories, new ContextService(x.stories, x.assets), new TurnService(x.stories), models, x.files)
  const queue = new RunQueue(x.stories, (id, signal) => executor.execute(id, signal, resources), error => faults.push(error))
  clean.push(async () => { await queue.close(); x.close(); expect(faults).toEqual([]) })
  const native = (id = story.id) => parentMessages(history.read(x.stories.snapshot(id)), x.files, models.resolve(route).model).messages
  async function send(text: string, script: Reply[], id = story.id, attachmentIds: string[] = []) {
    const start = requests.length
    replies.push(...script)
    const accepted = service.send(id, randomUUID(), [{ text, attachmentIds }])
    queue.wake(); await queue.idle()
    expect(x.stories.run(accepted.run.id), JSON.stringify({ faults, run: x.stories.run(accepted.run.id) })).toMatchObject({ status: 'completed' })
    expect(replies).toHaveLength(0)
    return { run: accepted.run, requests: requests.slice(start), story: x.stories.snapshot(id) }
  }
  return { ...x, story, service, models, resources, tools, history, queue, send, native, requests, replies, reads: () => reads }
}

describe('parent native message surface', () => {
  it.each(['chat', 'agent'] as const)('retains real tools between %s turns, without executing history or importing Writer messages', async mode => {
    const x = setup(mode)
    const finish = mode === 'chat' ? call('rp_reply', { text: '读过记录了。' }) : { text: '读过记录了。' }
    const first = await x.send('FIRST_NATIVE_INPUT', [call('inspect_note'), finish])
    const second = await x.send('SECOND_NATIVE_INPUT', [call('rp_write_turn', { action: 'write' }), { text: 'WRITER_PROSE_ONLY' }, call('rp_commit_turn', mode === 'agent' ? { narrative: 'FINAL_PROSE' } : {})])
    const request = second.requests[0]!, transcript = request.messages
    expect(x.reads()).toBe(1)
    expect(transcript.some((item: any) => item.role === 'user' && textOf(item.content) === 'FIRST_NATIVE_INPUT')).toBe(true)
    expect(transcript.some((item: any) => item.role === 'user' && textOf(item.content) === 'SECOND_NATIVE_INPUT')).toBe(true)
    expect(transcript.some((item: any) => item.role === 'assistant' && item.tool_calls?.some((tool: any) => tool.function.name === 'inspect_note'))).toBe(true)
    expect(transcript.some((item: any) => item.role === 'tool' && textOf(item.content).includes('NOTE_RESULT'))).toBe(true)
    expect(transcript.some((item: any) => item.role === 'user' && textOf(item.content).startsWith('<conversation_history>'))).toBe(false)
    const writer = second.requests[1]!
    expect(JSON.stringify(writer.messages)).not.toContain('NOTE_RESULT')
    expect(JSON.stringify(writer.messages)).not.toContain('reused-call-')
    const entries = x.history.read(second.story)
    expect(entries.filter(item => item.kind === 'input').map(item => (item.message.content as any[])[0].text)).toEqual(['FIRST_NATIVE_INPUT', 'SECOND_NATIVE_INPUT'])
    const calls = x.native().flatMap(item => item.role === 'assistant' ? item.content.filter(part => part.type === 'toolCall').map(part => part.id) : [])
    expect(calls.some(id => id.startsWith(first.run.id))).toBe(true)
    expect(calls.some(id => id.startsWith(second.run.id))).toBe(true)
  })

  it('uses current system and tool configuration, while retaining older disabled tool calls', async () => {
    const x = setup()
    await x.send('读一下', [call('inspect_note'), call('rp_reply', { text: '已读。' })])
    x.resources.contextPolicy = { identity: 'HEADER_CURRENT' }
    x.resources.tools = () => []
    const config = x.stories.snapshot(x.story.id).profile; config.runtime.executionMode = 'agent'
    x.service.updateProfile(x.story.id, x.stories.snapshot(x.story.id).revision, config)
    const result = await x.send('讨论计划', [{ text: '计划说明。' }])
    const body = result.requests[0]!
    expect(body.messages[0].content).toContain('HEADER_CURRENT')
    expect(body.messages[0].content).not.toContain('HEADER_ORIGINAL')
    expect(body.tools.some((item: any) => item.function.name === 'inspect_note')).toBe(false)
    expect(body.tools.some((item: any) => item.function.name === 'rp_reply')).toBe(true)
    expect(body.messages.some((item: any) => item.tool_calls?.some((tool: any) => tool.function.name === 'inspect_note'))).toBe(true)
    expect(x.reads()).toBe(1)
  })

  it('applies edits to native inputs/replies and invalidates snapshots containing stale text', async () => {
    const x = setup(), first = await x.send('OLD_USER_TEXT', [call('rp_reply', { text: 'OLD_REPLY_TEXT' })])
    let state = x.service.edit(x.story.id, first.story.revision, first.story.messages[0]!.id, 'EDITED_USER_TEXT')
    state = x.service.edit(x.story.id, state.revision, state.messages.at(-1)!.id, 'EDITED_REPLY_TEXT')
    const second = await x.send('再讨论', [call('rp_reply', { text: '最新说明。' })])
    const sent = JSON.stringify(second.requests[0]!.messages)
    expect(sent).toContain('EDITED_USER_TEXT'); expect(sent).toContain('EDITED_REPLY_TEXT')
    expect(sent).not.toContain('OLD_USER_TEXT'); expect(sent).not.toContain('OLD_REPLY_TEXT')
    expect(JSON.stringify(x.stories.eventLog(x.story.id))).toContain('OLD_REPLY_TEXT')
  })

  it('projects an edited Writer response as reply text for the next turn', async () => {
    const x = setup()
    const first = await x.send('先确认地点', [call('rp_write_turn', { action: 'write' }), { text: '请先确定故事地点。' }, call('rp_reply', { useWriterResult: true })])
    x.service.edit(x.story.id, first.story.revision, first.story.messages.at(-1)!.id, '请先确定地点与时间。')
    const next = await x.send('在灯塔', [call('rp_reply', { text: '已经确认。' })])
    const historicalReply = next.requests[0]!.messages.flatMap((item: any) => item.tool_calls ?? []).find((tool: any) => tool.function.name === 'rp_reply')
    expect(JSON.parse(historicalReply.function.arguments)).toEqual({ text: '请先确定地点与时间。' })
    expect(x.stories.eventLog(x.story.id).some(event => event.type === 'turn.committed')).toBe(false)
  })

  it('inherits a complete tool surface into a branch and survives deletion of the original story', async () => {
    const x = setup(), first = await x.send('分支的输入', [call('inspect_note'), call('rp_reply', { text: '分支回复。' })])
    const branch = x.service.fork(x.story.id, first.story.revision, first.story.messages.at(-1)!.id)
    expect(x.native(branch.id)).toEqual(x.native())
    const deletion = new StoryDeletionService(x.stories, new SidebarService(x.assets, x.stories), () => false)
    deletion.delete(x.story.id, x.stories.snapshot(x.story.id).revision)
    const next = await x.send('分支继续', [call('rp_reply', { text: '继续讨论。' })], branch.id)
    expect(JSON.stringify(next.requests[0])).toContain('NOTE_RESULT')
    expect(x.reads()).toBe(1)
  })

  it('restores an old branch from its original prefix instead of later source edits', async () => {
    const x = setup(), first = await x.send('ORIGINAL_AT_FORK', [call('inspect_note'), call('rp_reply', { text: '原来的回复。' })])
    const branch = x.service.fork(x.story.id, first.story.revision, first.story.messages.at(-1)!.id)
    x.database.sqlite.prepare("DELETE FROM events WHERE story_id = ? AND type = 'history.inherited'").run(branch.id)
    x.service.edit(x.story.id, x.stories.snapshot(x.story.id).revision, first.story.messages[0]!.id, 'EDITED_AFTER_FORK')
    const next = await x.send('继续旧分支', [call('rp_reply', { text: '保留旧分支。' })], branch.id)
    expect(JSON.stringify(next.requests[0])).toContain('ORIGINAL_AT_FORK')
    expect(JSON.stringify(next.requests[0])).not.toContain('EDITED_AFTER_FORK')
    expect(JSON.stringify(next.requests[0])).toContain('NOTE_RESULT')
  })

  it('cuts inherited tools at a user-only fork and at a deleted reply in a nested branch', async () => {
    const x = setup(), first = await x.send('BRANCH_INPUT', [call('inspect_note'), call('rp_reply', { text: 'BRANCH_REPLY' })])
    const branch = x.service.fork(x.story.id, first.story.revision, first.story.messages.at(-1)!.id)
    const userBranch = x.service.fork(branch.id, branch.revision, branch.messages[0]!.id)
    expect(JSON.stringify(x.native(userBranch.id))).not.toContain('NOTE_RESULT')
    expect(JSON.stringify(x.native(userBranch.id))).not.toContain('BRANCH_REPLY')
    expect(x.native(userBranch.id).some(item => textOf(item.content) === 'BRANCH_INPUT')).toBe(true)
    const removed = x.service.remove(branch.id, x.stories.snapshot(branch.id).revision, branch.messages.at(-1)!.id)
    expect(JSON.stringify(x.native(removed.id))).not.toContain('BRANCH_REPLY')
    expect(JSON.stringify(x.native(removed.id))).not.toContain('NOTE_RESULT')
    const next = await x.send('继续用户分支', [call('rp_reply', { text: 'NEW_BRANCH_REPLY' })], userBranch.id)
    expect(JSON.stringify(next.requests[0])).not.toContain('BRANCH_REPLY')
    expect(x.reads()).toBe(1)
  })

  it('pairs duplicate provider IDs by owner while preserving Responses metadata and deferring steering', () => {
    const x = setup(), runId = randomUUID()
    const entry = (seq: number, owner: string, kind: any, message: any) => ({ id: String(seq), seq, runId, ownerMessageId: owner, kind, message })
    const signature = 'provider-native-signature'
    const projected = parentMessages([
      entry(1, 'first', 'assistant', { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Native reasoning', thinkingSignature: signature },
        { type: 'toolCall', id: 'reused|fc_item1', name: 'inspect_note', arguments: {} },
        { type: 'toolCall', id: 'parallel', name: 'inspect_note', arguments: {} },
      ], api: 'openai-responses', provider: 'fixture', model: 'fixture', timestamp: 1, stopReason: 'toolUse' }),
      entry(2, 'user', 'input', { role: 'user', content: [{ type: 'text', text: 'STEERING' }], timestamp: 2 }),
      entry(3, 'first', 'toolResult', { role: 'toolResult', toolCallId: 'parallel', toolName: 'inspect_note', content: [{ type: 'text', text: 'TOOL_ERROR' }], isError: true, timestamp: 3 }),
      entry(4, 'first', 'toolResult', { role: 'toolResult', toolCallId: 'reused|fc_item1', toolName: 'inspect_note', content: [{ type: 'text', text: 'TOOL_OK' }], isError: false, timestamp: 4 }),
      entry(5, 'second', 'assistant', { role: 'assistant', content: [{ type: 'toolCall', id: 'reused|fc_item2', name: 'inspect_note', arguments: {} }], timestamp: 5 }),
      entry(6, 'second', 'toolResult', { role: 'toolResult', toolCallId: 'reused|fc_item2', toolName: 'inspect_note', content: [{ type: 'text', text: 'SECOND_OK' }], isError: false, timestamp: 6 }),
      entry(7, 'unfinished', 'assistant', { role: 'assistant', content: [{ type: 'toolCall', id: 'crash', name: 'inspect_note', arguments: {} }], timestamp: 7 }),
    ], x.files, x.models.resolve(route).model)
    expect(projected.messages.map(item => item.role)).toEqual(['assistant', 'toolResult', 'toolResult', 'user', 'assistant', 'toolResult'])
    expect(projected.omitted).toHaveLength(1)
    expect(JSON.stringify(projected.messages)).toContain(signature)
    const ids = projected.messages.flatMap(item => item.role === 'toolResult' ? [item.toolCallId] : [])
    expect(new Set(ids).size).toBe(3)
    expect(ids.every(id => /^[a-zA-Z0-9_-]+(?:\|fc_item[12])?$/.test(id))).toBe(true)
    expect(ids.some(id => id.endsWith('|fc_item1'))).toBe(true)
    expect(ids.some(id => id.endsWith('|fc_item2'))).toBe(true)
  })

  it('deletes assistant-owned calls and regenerates only the retained real inputs', async () => {
    const x = setup(), first = await x.send('重生成输入', [call('inspect_note'), call('rp_reply', { text: 'FIRST_ATTEMPT_REPLY' })])
    x.service.remove(x.story.id, first.story.revision, first.story.messages.at(-1)!.id)
    expect(JSON.stringify(x.native())).not.toContain('NOTE_RESULT')
    expect(x.native().filter(item => item.role === 'user' && textOf(item.content) === '重生成输入')).toHaveLength(1)
    const state = x.stories.snapshot(x.story.id)
    const replay = x.service.regenerate(state.id, state.revision, state.messages.at(-1)!.id, randomUUID())
    x.replies.push(call('rp_reply', { text: 'SECOND_ATTEMPT_REPLY' }))
    x.queue.wake(); await x.queue.idle()
    expect(x.stories.run(replay.run.id).status).toBe('completed')
    const messages = x.requests.at(-1)!.messages
    expect(messages.filter((item: any) => item.role === 'user' && textOf(item.content) === '重生成输入')).toHaveLength(1)
    expect(JSON.stringify(messages)).not.toContain('FIRST_ATTEMPT_REPLY')
    expect(JSON.stringify(messages)).not.toContain('NOTE_RESULT')
  })

  it('restores attachment bytes on subsequent turns and on branches', async () => {
    const x = setup()
    const png = x.files.save(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVJ8AAAAASUVORK5CYII=', 'base64'), 'pixel.png', 'image/png')
    await x.send('查看这张图片', [call('rp_reply', { text: '已查看图片。' })], x.story.id, [png.id])
    const result = await x.send('继续讨论图片', [call('rp_reply', { text: '继续讨论。' })])
    expect(result.requests[0]!.messages.some((item: any) => Array.isArray(item.content) && item.content.some((part: any) => part.type === 'image_url'))).toBe(true)
    const branch = x.service.fork(x.story.id, result.story.revision, result.story.messages.at(-1)!.id)
    expect(x.native(branch.id).some(item => Array.isArray(item.content) && item.content.some(part => part.type === 'image'))).toBe(true)
  })

  it('compacts complete exchanges and discards historical snapshots that quote the covered prefix', async () => {
    const x = setup(), first = await x.send('COVERED_INPUT', [call('inspect_note'), call('rp_reply', { text: 'COVERED_REPLY' })])
    await x.send('RECENT_INPUT', [call('inspect_note'), call('rp_reply', { text: 'RECENT_REPLY' })])
    const covered = first.story.messages.filter(item => item.kind !== 'tool')
    x.stories.append(x.story.id, { type: 'summary.created', data: { sourceMessageIds: covered.map(item => item.id), throughMessageId: covered.at(-1)!.id, text: 'CHECKPOINT_SUMMARY' } })
    const next = await x.send('AFTER_SUMMARY', [call('rp_reply', { text: '新说明。' })])
    const request = JSON.stringify(next.requests[0]!.messages)
    expect(request).not.toContain('COVERED_INPUT'); expect(request).not.toContain('COVERED_REPLY')
    expect(request).toContain('RECENT_INPUT'); expect(request).toContain('RECENT_REPLY')
    expect(request).toContain('NOTE_RESULT'); expect(request.match(/CHECKPOINT_SUMMARY/g)).toHaveLength(1)
  })

  it('keeps user-authored openings native and excludes partial drafts and child model records', () => {
    const x = setup(), opening = message('assistant', '开场正文', { kind: 'opening' })
    x.stories.append(x.story.id, { type: 'message.added', data: { message: opening } })
    const run = x.service.send(x.story.id, 'pending', [{ text: '当前输入', attachmentIds: [] }]).run
    x.stories.append(x.story.id, { type: 'model.message', data: { runId: run.id, ownerMessageId: 'child', role: 'writer:assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CHILD_PRIVATE' }] } } })
    x.stories.append(x.story.id, { type: 'message.added', data: { message: message('assistant', 'PARTIAL_DRAFT', { runId: run.id, kind: 'draft' }) } })
    const projected = projectModelHistory(x.stories.historyEvents(x.story.id), x.stories.snapshot(x.story.id), null, run.id)
    expect(projected.entries[0]).toMatchObject({ kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '开场正文' }] } })
    expect(JSON.stringify(projected)).not.toContain('PARTIAL_DRAFT'); expect(JSON.stringify(projected)).not.toContain('CHILD_PRIVATE')
  })
})
