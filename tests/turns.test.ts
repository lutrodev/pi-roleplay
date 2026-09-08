import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { RpError } from '../packages/rp-core/src/errors.ts'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import type { ExecutionMode, JsonObject, StateEffect } from '../packages/rp-core/src/types.ts'
import { fixture, message, profile } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => { for (const item of fixtures.splice(0)) item.close() })
const definition = {
  title: '故事', updateMode: 'schema-only',
  schema: { type: 'object', properties: { energy: { type: 'number', minimum: 0 } }, required: ['energy'], additionalProperties: false }, rules: [],
}
function setup(mode: ExecutionMode = 'chat') {
  const item = fixture(); fixtures.push(item)
  const config = profile(); config.runtime.executionMode = mode
  const story = item.stories.create('测试故事', config, { namespaces: {
    story: createNamespaceSnapshot({ definition, initialValue: { energy: 10 } }),
    other: createNamespaceSnapshot({ definition, initialValue: { energy: 5 } }),
  } })
  const run = item.stories.enqueue({ storyId: story.id, requestId: 'request', inputHash: 'input', turnId: 'turn' }, run => {
    item.stories.append(story.id, { type: 'message.added', data: { message: message('user', '继续前进', { turnId: run.turnId, runId: run.id }) } })
  }).run
  item.stories.setRunStatus(run.id, 'running')
  const context = item.stories.append(story.id, { type: 'context.built', data: { runId: run.id, writerPrompt: '本轮写作资料', parentPrompt: '本轮编排资料', sources: [{ id: 'character', revision: 1 }], model: { provider: 'test', model: 'test' } } })
  return { ...item, story, run, context, turns: new TurnService(item.stories), service: new StoryService(item.stories, item.assets, item.files), owner: randomUUID() }
}
function effect(namespace = 'story', expectedRevision = 1, by = -1): StateEffect {
  return { kind: 'state.update', namespace, expectedRevision, payload: { changes: [{ op: 'increment', path: '/energy', by, reason: '前进消耗精力' }] } }
}

describe('Writer and atomic narrative commits', () => {
  it.each([0, 1])('accepts an extension exactly at the byte budget and drops it %s bytes over', async excess => {
    const x = setup(), text = '本轮正文。', namespace = 'rp.reply-options'
    x.turns.recordWriter(x.run.id, 'write', x.context.seq, text)
    const core = { text, summary: '', effects: [], references: [], extensions: { [namespace]: { version: 1, options: [''] } } }
    const size = 262_144 - Buffer.byteLength(JSON.stringify(core), 'utf8') + excess
    const value = { version: 1, options: ['x'.repeat(size)] }
    const committed = await x.turns.commit(x.run.id, x.owner, '', { runSummary: '', extensions: { [namespace]: value } }, true, undefined, { count: 1, maxCharacters: 50, keywords: [''] })
    if (committed.type !== 'turn.committed') throw new Error('Expected narrative commit')
    expect(committed.data.extensions[namespace]).toEqual(excess === 0 ? value : undefined)
    expect(committed.data.diagnostics?.[0]?.code).toBe(excess === 0 ? undefined : 'RP_GENERATED_ARTIFACT_LIMIT')
    expect(x.stories.snapshot(x.story.id).messages.at(-1)?.text).toBe(text)
  })

  it('requires a successful Writer and commits its exact text in Chat mode', async () => {
    const x = setup()
    await expect(x.turns.commit(x.run.id, x.owner, '父模型直接写的正文', {})).rejects.toThrow('先完成')
    x.turns.recordWriter(x.run.id, 'write-a', x.context.seq, 'Writer 的完整正文。')
    await x.turns.commit(x.run.id, x.owner, '父模型试图改写', { effects: [effect()] })
    const result = x.stories.snapshot(x.story.id)
    expect(result.messages.at(-1)?.text).toBe('Writer 的完整正文。')
    expect(result.state.namespaces.story?.value).toEqual({ energy: 9 })
  })

  it('allows the Agent parent to revise Writer prose before committing', async () => {
    const x = setup('agent')
    x.turns.recordWriter(x.run.id, 'write-a', x.context.seq, '初稿。')
    await x.turns.commit(x.run.id, x.owner, '修改后的正文。', { runSummary: '走进灯塔。' })
    expect(x.stories.snapshot(x.story.id).messages.at(-1)?.text).toBe('修改后的正文。')
    expect(x.stories.snapshot(x.story.id).summaries.at(-1)?.text).toBe('走进灯塔。')
  })

  it('applies no partial effects on failure, then accepts a correction-only retry exactly once', async () => {
    const x = setup()
    x.turns.recordWriter(x.run.id, 'write-a', x.context.seq, '准备提交的正文。')
    let failure: RpError | undefined
    try { await x.turns.commit(x.run.id, x.owner, '', { effects: [effect(), effect('other', 99)] }) }
    catch (error) { failure = error as RpError }
    expect(failure?.code).toBe('STATE_REVISION_CONFLICT')
    expect(x.stories.snapshot(x.story.id).state.namespaces.story?.value).toEqual({ energy: 10 })
    expect(x.stories.snapshot(x.story.id).messages).toHaveLength(1)
    const token = (failure?.details as { retry: { token: string } }).retry.token
    await x.turns.commit(x.run.id, 'different-step-owner', '', { retry: { token, patches: [{ op: 'replace', path: '/effects/1/expectedRevision', value: 1 }] } })
    const snapshot = x.stories.snapshot(x.story.id)
    expect(snapshot.messages.at(-1)?.id).toBe(x.owner)
    expect(snapshot.state.namespaces.story?.value).toEqual({ energy: 9 })
    expect(snapshot.state.namespaces.other?.value).toEqual({ energy: 4 })
    await x.turns.commit(x.run.id, x.owner, '', { effects: [effect(), effect('other')] })
    expect(x.stories.snapshot(x.story.id)).toEqual(snapshot)
    await expect(x.turns.commit(x.run.id, x.owner, '', { effects: [] })).rejects.toThrow('不同的正文')
  })

  it('rejects an invalid final state and guessed reference revisions without saving a reply', async () => {
    const x = setup()
    x.turns.recordWriter(x.run.id, 'write-a', x.context.seq, '不能污染状态。')
    await expect(x.turns.commit(x.run.id, x.owner, '', { effects: [effect('story', 1, -20)] })).rejects.toThrow('不符合当前规则')
    await expect(x.turns.commit(x.run.id, x.owner, '', { references: [{ source: 'character', id: 'card', revision: 2 }] })).rejects.toThrow('不在本轮')
    expect(x.stories.snapshot(x.story.id).state.namespaces.story?.value).toEqual({ energy: 10 })
    expect(x.stories.snapshot(x.story.id).messages).toHaveLength(1)
  })

  it('rejects two updates to one namespace even with sequential revision numbers', async () => {
    const x = setup()
    x.turns.recordWriter(x.run.id, 'writer', x.context.seq, '本轮正文。')
    await expect(x.turns.commit(x.run.id, x.owner, '', { effects: [effect('story', 1), effect('story', 2)] })).rejects.toThrow('同一变量组')
    expect(x.stories.snapshot(x.story.id).state.namespaces.story?.value).toEqual({ energy: 10 })
  })

  it('requires a new context and Writer after changing variable definitions', async () => {
    const x = setup('agent')
    x.stories.append(x.story.id, { type: 'message.added', data: { message: message('assistant', '配置变量', { id: x.owner, kind: 'tool', runId: x.run.id, turnId: x.run.turnId }) } })
    x.turns.recordWriter(x.run.id, 'write-a', x.context.seq, '旧变量下的正文。')
    x.turns.configureState(x.run.id, x.owner, { operation: 'update', namespace: 'story', expectedRevision: 1, definition, value: { energy: 20 } })
    await expect(x.turns.commit(x.run.id, x.owner, '旧稿', {})).rejects.toThrow('重新准备')
    const context = x.stories.append(x.story.id, { type: 'context.built', data: { runId: x.run.id, writerPrompt: '更新后的变量', parentPrompt: '', sources: [], model: { provider: 'test', model: 'test' } } })
    x.turns.recordWriter(x.run.id, 'write-b', context.seq, '新变量下的正文。')
    await x.turns.commit(x.run.id, x.owner, '采用新变量的正文。', {})
    x.stories.setRunStatus(x.run.id, 'completed')
    const committed = x.stories.snapshot(x.story.id)
    expect(committed.state.namespaces.story?.value).toEqual({ energy: 20 })
    x.service.remove(x.story.id, committed.revision, x.owner)
    expect(x.stories.snapshot(x.story.id).state.namespaces.story?.value).toEqual({ energy: 10 })
  })

  it('disallows variable configuration in Chat mode', () => {
    const x = setup()
    expect(() => x.turns.configureState(x.run.id, x.owner, { operation: 'delete', namespace: 'story', expectedRevision: 1 })).toThrow('Agent')
  })

  it('rejects the 33rd namespace before any durable write and leaves the existing Writer usable', async () => {
    const x = setup('agent')
    x.stories.append(x.story.id, { type: 'message.added', data: { message: message('assistant', '配置变量', { id: x.owner, kind: 'tool', runId: x.run.id, turnId: x.run.turnId }) } })
    for (let index = 2; index < 32; index++) x.turns.configureState(x.run.id, x.owner, {
      operation: 'create', namespace: `group${index}`, expectedRevision: 0, definition, initialValue: { energy: 10 },
    })
    const contexts = new ContextService(x.stories, x.assets), model = { provider: 'test', model: 'test' }
    const frozen = contexts.freeze(x.run.id, model)
    x.turns.recordWriter(x.run.id, 'writer', frozen.seq, '三十二组变量下的正文。')
    const before = x.stories.eventLog(x.story.id)
    expect(() => x.turns.configureState(x.run.id, x.owner, {
      operation: 'create', namespace: 'overflow', expectedRevision: 0, definition, initialValue: { energy: 10 },
    })).toThrow(expect.objectContaining({ code: 'STATE_NAMESPACE_LIMIT' }))
    expect(x.stories.eventLog(x.story.id)).toEqual(before)
    expect(() => contexts.preview(x.story.id, x.run.id, model)).not.toThrow()
    await x.turns.commit(x.run.id, x.owner, '三十二组变量下的正文。', { effects: [effect()] })
    expect(x.stories.snapshot(x.story.id).state.namespaces.story!.value).toEqual({ energy: 9 })
    expect(Object.keys(x.stories.snapshot(x.story.id).state.namespaces)).toHaveLength(32)
  })

  it('keeps every-turn omissions as visible diagnostics instead of inventing updates', async () => {
    const x = setup('agent')
    x.stories.append(x.story.id, { type: 'message.added', data: { message: message('assistant', '变量配置', { id: x.owner, kind: 'tool', runId: x.run.id, turnId: x.run.turnId }) } })
    x.turns.configureState(x.run.id, x.owner, { operation: 'update', namespace: 'story', expectedRevision: 1, definition: {
      ...definition, rules: [{ id: 'energy-rule', target: '/energy', when: '检查本轮精力变化', cadence: 'every-turn', effect: { op: 'increment', minimum: -1, maximum: 0 } }],
    } })
    const context = x.stories.append(x.story.id, { type: 'context.built', data: { runId: x.run.id, writerPrompt: '', parentPrompt: '', sources: [], model: { provider: 'test', model: 'test' } } })
    x.turns.recordWriter(x.run.id, 'write-a', context.seq, '片刻停留。')
    await x.turns.commit(x.run.id, randomUUID(), '片刻停留。', {})
    const result = x.stories.snapshot(x.story.id).state.namespaces.story!
    expect(result.value).toEqual({ energy: 10 })
    expect(result.revision).toBe(2)
    expect(result.diagnostics.lastCommit[0]?.code).toBe('STATE_EVERY_TURN_MISSED')
  })
})
