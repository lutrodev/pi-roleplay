import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReplyOptionsService } from '../apps/server/src/services/reply-options-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { RunJournal } from '../apps/server/src/runtime/journal.ts'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { StoryRepository } from '../apps/server/src/storage/story-repository.ts'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import { RpError } from '../packages/rp-core/src/errors.ts'
import type { ExecutionMode, JsonObject } from '../packages/rp-core/src/types.ts'
import { fixture, message, profile, recordModelReply } from './helpers.ts'

const clean: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of clean.splice(0)) await cleanup(); vi.restoreAllMocks() })
const route = { provider: 'synthetic', model: 'options' }, config = { count: 2, maxCharacters: 40, keywords: ['出海', ''] }
const namespace = 'rp.reply-options', prose = '旅人推开窗户，看向大海。'
function setup(mode: ExecutionMode = 'chat', suggestionConfig = config) {
  const x = fixture(), service = new StoryService(x.stories, x.assets, x.files), turns = new TurnService(x.stories)
  const card = x.assets.create('character', { name: '旅人', description: '冻结的角色设定' })
  const book = x.assets.create('lorebook', { name: '当前场景', entries: [
    { id: 'live', constant: true, content: '当前变量：精力=<%= getvar("stat_data.energy[0]") %>；地点=<%= getvar("stat_data.location[0]") %>。' },
    { id: 'tired', constant: true, stateCondition: 'state("story", "/energy") < 8', content: '体力不足，只能休息。' },
    { id: 'rested', constant: true, stateCondition: 'state("story", "/energy") >= 8', content: '休息充分，可以远行。' },
    { id: 'sea', keys: ['大海'], content: '海上可以看见白帆。' },
  ] })
  const state = { namespaces: { story: createNamespaceSnapshot({ initialValue: { energy: 7, location: '楼梯' }, definition: {
    title: '当前场景', updateMode: 'schema-only', rules: [], schema: { type: 'object', properties: {
      energy: { type: 'integer', description: '精力' }, location: { type: 'string', description: '地点' },
    } },
  } }) } }
  const story = x.stories.create('续写选项', { ...profile(), cast: [
    { characterId: 'player', name: '林舟', controller: 'user' }, { characterId: 'visitor', name: '旅人', controller: 'agent' },
  ], runtime: { executionMode: mode }, resources: { card: { id: card.id }, lorebooks: [{ id: book.id }], writingStyles: [] } }, state)
  const run = service.send(story.id, 'main', [{ text: '开始旅行。', attachmentIds: [] }]).run
  x.stories.setRunStatus(run.id, 'running')
  const context = new ContextService(x.stories, x.assets).freeze(run.id, route)
  turns.recordWriter(run.id, 'writer', context.seq, prose)
  const messageId = randomUUID(), controller = new AbortController(), preferences = { enabled: true }
  const input: JsonObject = { effects: [{ kind: 'state.update', namespace: 'story', expectedRevision: 1, payload: { changes: [
    { op: 'increment', path: '/energy', by: 1, reason: '已休息' }, { op: 'set', path: '/location', value: '灯塔', reason: '到达灯塔' },
  ] } }] }
  let respond!: (response: Response) => void
  const requests: Record<string, unknown>[] = [], pending: Promise<unknown>[] = []
  const models = new ModelRegistry([{ ...route, keyEnv: 'TEST_KEY', api: 'openai-completions', baseUrl: 'https://model.test/v1', contextWindow: 32000, maxTokens: 8192 }], {
    env: () => 'synthetic-secret', fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(new Error('cancelled'))
        init?.signal?.addEventListener('abort', abort, { once: true })
        respond = response => { init?.signal?.removeEventListener('abort', abort); resolve(response) }
        if (init?.signal?.aborted) abort()
      })
    },
  })
  const options = new ReplyOptionsService(models), journal = new RunJournal(x.stories, x.files, run)
  const commit = (draft = input, owner: string = messageId, narrative = prose, guard?: () => void) => {
    const promise = turns.commit(run.id, owner, narrative, draft, true, () => { controller.signal.throwIfAborted(); guard?.() },
      commit => options.generate({ commit, route, config: suggestionConfig, context, journal, signal: controller.signal, enabled: () => preferences.enabled }))
    pending.push(promise); return promise
  }
  clean.push(async () => { controller.abort(); await Promise.allSettled(pending); x.close() })
  const complete = (value: unknown) => respond(new Response(`data: ${JSON.stringify({ id: 'options', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'emit', type: 'function', function: { name: 'emit_reply_options', arguments: JSON.stringify(value) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
  return { ...x, story, run, messageId, card, book, context, service, turns, options, requests, commit, input, complete, controller, preferences,
    fail: () => respond(new Response('{"error":{"message":"synthetic provider error"}}', { status: 400, headers: { 'content-type': 'application/json' } })) }
}

describe('reply options owned by the narrative commit', () => {
  it('waits for suggestions and publishes narrative, state and normalized options in one event', async () => {
    const x = setup(), before = x.stories.snapshot(x.story.id), pending = x.commit()
    await expect.poll(() => x.requests.length).toBe(1)
    const waiting = x.stories.snapshot(x.story.id)
    expect(waiting.messages).toEqual(before.messages); expect(waiting.state).toEqual(before.state)
    expect(waiting.replyOptions).toEqual({}); expect(waiting.maintenance['reply-options']).toBeUndefined()
    expect(x.stories.hasCommitted(x.run.id)).toBe(false)
    expect(x.stories.run(x.run.id).status).toBe('running')
    x.complete({ note: 'harmless', options: [' 他走向海岸。 ', '', '他走向海岸。', '他留在灯塔。'] })
    const event = await pending, after = x.stories.snapshot(x.story.id)
    if (event.type !== 'turn.committed') throw new Error('Expected the single narrative commit')
    expect(event.data.extensions[namespace]).toEqual({ version: 1, options: ['他走向海岸。', '他留在灯塔。'] })
    expect(after.messages.at(-1)?.text).toBe(prose)
    expect(after.state.namespaces.story?.value).toEqual({ energy: 8, location: '灯塔' })
    expect(after.replyOptions[x.messageId]).toEqual(['他走向海岸。', '他留在灯塔。'])
    expect(x.stories.eventsOfTypes(x.story.id, ['turn.committed'])).toHaveLength(1)
    expect(x.stories.eventsOfTypes(x.story.id, ['reply-options.ready', 'maintenance.status'])).toEqual([])
    expect((x.requests[0]!.tools as { function: { name: string } }[]).map(tool => tool.function.name)).toEqual(['emit_reply_options'])
    await x.commit(); expect(x.requests).toHaveLength(1)
  })

  it('uses the proposed final state with frozen assets, including MVU and newly activated lore', async () => {
    const x = setup()
    x.assets.update(x.card.id, x.card.revision, { name: '旅人', description: '后续编辑不应混入' })
    x.assets.remove(x.book.id, x.book.revision)
    const pending = x.commit(); await expect.poll(() => x.requests.length).toBe(1)
    const prompt = JSON.stringify(x.requests[0])
    for (const text of ['当前变量：精力=8；地点=灯塔。', '休息充分，可以远行。', '海上可以看见白帆。', '冻结的角色设定', 'Option 1 direction: 出海']) expect(prompt).toContain(text)
    for (const text of ['当前变量：精力=7；地点=楼梯。', '体力不足，只能休息。', '后续编辑不应混入', 'state_commit_contract']) expect(prompt).not.toContain(text)
    expect(x.context.writerPrompt).toContain('当前变量：精力=7；地点=楼梯。')
    expect(x.stories.snapshot(x.story.id).state.namespaces.story?.value).toEqual({ energy: 7, location: '楼梯' })
    x.complete({ options: ['旅人走向海岸。'] }); await pending
  })

  it('sends option-specific user directions ahead of default style and preserves the chosen output without forcing a name or dialogue', async () => {
    const directions = { count: 3, maxCharacters: 80, keywords: ['只用第一人称对白，婉拒同行，不写姓名或动作', '', '保持沉默，用动作表示愿意同行'] }
    const original = structuredClone(directions), x = setup('chat', directions), pending = x.commit()
    await expect.poll(() => x.requests.length).toBe(1)
    const request = x.requests[0]!
    const messages = request.messages as { role: string; content: string }[]
    const prompt = messages.find(item => item.role === 'user')!.content
    const tool = (request.tools as { function: { parameters: { description: string } } }[])[0]!.function.parameters
    for (const instructions of [prompt, tool.description]) {
      expect(instructions).toMatch(/User-authored directions take precedence over the default writing rules/)
      expect(instructions.indexOf('take precedence')).toBeLessThan(instructions.indexOf('Default writing rules:'))
      expect(instructions).toContain(`Option 1 direction: ${directions.keywords[0]}`)
      expect(instructions).toContain(`Option 3 direction: ${directions.keywords[2]}`)
      expect(instructions).not.toContain('Option 2 direction:')
    }
    const identity = JSON.parse(prompt.match(/<player_identity[^>]*>\n([^\n]+)\n<\/player_identity>/)![1]!)
    expect(identity).toEqual({ characterId: 'player', name: '林舟' })
    expect(prompt).toContain(prose)
    const suggestions = ['“我想先留在这里。”', '林舟望向大海：“哪条路能到岸边？”', '林舟没有说话，只迈步跟上。']
    x.complete({ options: suggestions }); await pending
    expect(x.stories.snapshot(x.story.id).replyOptions[x.messageId]).toEqual(suggestions)
    expect(directions).toEqual(original)
  })

  it('rejects a concurrent commit without starting another generation or changing the pending result', async () => {
    const x = setup(), pending = x.commit()
    await expect.poll(() => x.requests.length).toBe(1)
    await expect(x.commit()).rejects.toMatchObject({ code: 'COMMIT_IN_PROGRESS' })
    expect(x.requests).toHaveLength(1)
    x.complete({ options: ['旅人走向海岸。'] }); await pending
    expect(x.stories.eventsOfTypes(x.story.id, ['turn.committed'])).toHaveLength(1)
    expect(x.stories.snapshot(x.story.id).replyOptions[x.messageId]).toEqual(['旅人走向海岸。'])
  })

  it('generates from the Agent final narrative after revision rather than its Writer draft', async () => {
    const x = setup('agent'), pending = x.commit(x.input, x.messageId, '旅人转身走向山间。')
    await expect.poll(() => x.requests.length).toBe(1)
    const prompt = JSON.stringify(x.requests[0])
    expect(prompt).toContain('旅人转身走向山间。'); expect(prompt).not.toContain(prose)
    x.complete({ options: ['旅人沿着山路前行。'] }); await pending
    expect(x.stories.snapshot(x.story.id).messages.at(-1)?.text).toBe('旅人转身走向山间。')
  })

  it('generates only after validation and only once for a successful correction-only retry', async () => {
    const x = setup()
    const failure = await x.commit({ ...x.input, references: [{ source: 'missing', id: 'missing', revision: 1 }] }).catch(error => error as RpError)
    expect(failure).toBeInstanceOf(RpError); expect(x.requests).toHaveLength(0)
    const token = (failure as RpError).details as { retry: { token: string } }
    x.stories.append(x.story.id, { type: 'message.added', data: { message: message('assistant', '', { kind: 'tool', runId: x.run.id, turnId: x.run.turnId }) } })
    const pending = x.commit({ retry: { token: token.retry.token, patches: [{ op: 'replace', path: '/references', value: [] }] } }, 'later-hidden-owner')
    await expect.poll(() => x.requests.length).toBe(1)
    x.complete({ options: ['旅人沿着海岸前行。'] }); await pending
    expect(x.stories.snapshot(x.story.id).replyOptions[x.messageId]).toEqual(['旅人沿着海岸前行。'])
    await x.commit(); expect(x.requests).toHaveLength(1)
  })

  it.each(['initially', 'during generation'] as const)('skips suggestions when disabled %s and still commits the narrative', async timing => {
    const x = setup()
    if (timing === 'initially') x.preferences.enabled = false
    const pending = x.commit()
    if (timing === 'during generation') {
      await expect.poll(() => x.requests.length).toBe(1)
      x.preferences.enabled = false; x.options.cancelAll()
    }
    const event = await pending
    if (event.type !== 'turn.committed') throw new Error('Expected the single narrative commit')
    expect(event.data.extensions).toEqual({}); expect(event.data.diagnostics).toBeUndefined()
    expect(x.stories.snapshot(x.story.id).messages.at(-1)?.text).toBe(prose)
    expect(x.requests).toHaveLength(timing === 'initially' ? 0 : 1)
  })

  it.each(['provider', 'invalid output', 'timeout'] as const)('records a %s failure in the same commit without retrying the narrative', async failure => {
    const timeout = new AbortController()
    if (failure === 'timeout') vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const x = setup(), pending = x.commit()
    await expect.poll(() => x.requests.length).toBe(1)
    if (failure === 'provider') x.fail()
    else if (failure === 'invalid output') x.complete({ options: [] })
    else timeout.abort(new DOMException('Timed out', 'TimeoutError'))
    const event = await pending, story = x.stories.snapshot(x.story.id)
    if (event.type !== 'turn.committed') throw new Error('Expected the single narrative commit')
    expect(event.data.extensions).toEqual({})
    expect(event.data.diagnostics?.[0]?.code).toBe(failure === 'timeout' ? 'REPLY_OPTIONS_TIMEOUT' : 'REPLY_OPTIONS_FAILED')
    expect(story.maintenance['reply-options']).toMatchObject({ status: 'failed', messageId: x.messageId })
    expect(story.messages.at(-1)?.text).toBe(prose)
    expect(story.state.namespaces.story?.value).toEqual({ energy: 8, location: '灯塔' })
    expect(x.stories.eventsOfTypes(x.story.id, ['turn.committed'])).toHaveLength(1)
    expect(x.requests).toHaveLength(1)
  })

  it('cancels the entire uncommitted turn when its parent stops', async () => {
    const x = setup(), before = x.stories.snapshot(x.story.id), pending = x.commit()
    await expect.poll(() => x.requests.length).toBe(1)
    const rejected = expect(pending).rejects.toThrow('停止生成')
    x.controller.abort(new RpError('RUN_CANCELLED', '停止生成')); await rejected
    const after = x.stories.snapshot(x.story.id)
    expect(after.messages).toEqual(before.messages); expect(after.state).toEqual(before.state)
    expect(after.replyOptions).toEqual({}); expect(x.stories.hasCommitted(x.run.id)).toBe(false)
    x.stories.recoverInterrupted()
    expect(x.stories.run(x.run.id).status).toBe('interrupted'); expect(x.requests).toHaveLength(1)
  })

  it.each(['state', 'input', 'guard'] as const)('rechecks %s after generation and commits nothing when it changed', async change => {
    const x = setup(); let ready = true
    const pending = x.commit(x.input, x.messageId, prose, () => { if (!ready) throw new RpError('GUARD_CHANGED', '资料已变更') })
    await expect.poll(() => x.requests.length).toBe(1)
    if (change === 'state') {
      const owner = message('assistant', '', { kind: 'tool', runId: x.run.id, turnId: x.run.turnId })
      x.stories.append(x.story.id, { type: 'message.added', data: { message: owner } })
      const state = x.stories.snapshot(x.story.id).state.namespaces.story!
      x.stories.append(x.story.id, { type: 'state.configured', data: { ownerMessageId: owner.id, update: { namespace: 'story', snapshot: { ...state, revision: 2, value: { energy: 0, location: '楼梯' } } } } })
    } else if (change === 'input') x.stories.append(x.story.id, { type: 'message.added', data: { message: message('user', '临时改变行动。', { runId: x.run.id, turnId: x.run.turnId }) } })
    else ready = false
    const rejected = expect(pending).rejects.toBeInstanceOf(RpError)
    x.complete({ options: ['过期的选项。'] }); await rejected
    expect(x.stories.hasCommitted(x.run.id)).toBe(false)
    expect(x.stories.snapshot(x.story.id).replyOptions).toEqual({})
  })

  it('replays options with their commit across restart and fork, and retracts edited or removed owners', async () => {
    const x = setup(), pending = x.commit()
    await expect.poll(() => x.requests.length).toBe(1)
    x.complete({ options: ['旅人走向海岸。'] }); await pending
    recordModelReply(x.stories, x.run, x.messageId, prose)
    x.stories.setRunStatus(x.run.id, 'completed')
    const saved = x.stories.snapshot(x.story.id), branch = x.service.fork(saved.id, saved.revision, x.messageId)
    expect(branch.replyOptions[x.messageId]).toEqual(['旅人走向海岸。'])
    const reopened = new AppDatabase(x.filename)
    try { expect(new StoryRepository(reopened).snapshot(x.story.id).replyOptions).toEqual(saved.replyOptions) } finally { reopened.close() }
    expect(x.service.edit(saved.id, saved.revision, x.messageId, '旅人关上窗户。').replyOptions).toEqual({})
    expect(x.service.remove(branch.id, branch.revision, x.messageId).replyOptions).toEqual({})
  })
})
