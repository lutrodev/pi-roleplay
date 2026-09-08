import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { StoryRepository } from '../apps/server/src/storage/story-repository.ts'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import { RpError } from '../packages/rp-core/src/errors.ts'
import type { ExecutionMode, JsonObject } from '../packages/rp-core/src/types.ts'
import { fixture, profile, recordModelReply } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => { for (const item of fixtures.splice(0)) item.close() })
const config = { count: 2, maxCharacters: 40, keywords: ['出海', ''] }
const namespace = 'rp.reply-options', prose = '林舟走到灯塔窗边，休息后看向大海。'
function setup(mode: ExecutionMode = 'chat') {
  const x = fixture(); fixtures.push(x)
  const service = new StoryService(x.stories, x.assets, x.files), turns = new TurnService(x.stories)
  const state = { namespaces: { story: createNamespaceSnapshot({ initialValue: { energy: 7 }, definition: {
    title: '当前场景', updateMode: 'schema-only', rules: [],
    schema: { type: 'object', properties: { energy: { type: 'integer', minimum: 0 } }, required: ['energy'], additionalProperties: false },
  } }) } }
  const story = x.stories.create('续写选项', { ...profile(), runtime: { executionMode: mode } }, state)
  const run = service.send(story.id, 'main', [{ text: '开始旅行。', attachmentIds: [] }]).run
  x.stories.setRunStatus(run.id, 'running')
  const context = new ContextService(x.stories, x.assets).freeze(run.id, { provider: 'test', model: 'test' })
  turns.recordWriter(run.id, 'writer', context.seq, prose)
  const messageId = randomUUID(), preferences = { enabled: true }
  const input: JsonObject = {
    effects: [{ kind: 'state.update', namespace: 'story', expectedRevision: 1, payload: { changes: [{ op: 'increment', path: '/energy', by: 1, reason: '已休息' }] } }],
    extensions: { [namespace]: { options: ['林舟走向海岸。', '林舟留在灯塔。'] } },
  }
  const commit = (draft = input, owner: string = messageId, narrative = prose, guard?: () => void) =>
    turns.commit(run.id, owner, narrative, draft, true, guard, preferences.enabled ? config : undefined)
  return { ...x, story, run, messageId, service, turns, commit, input, preferences }
}

describe('main-model reply options in the narrative commit', () => {
  it('publishes narrative, state and normalized choices in one event without applying twice', async () => {
    const x = setup()
    x.input.extensions = { [namespace]: { note: 'harmless annotation', options: [' 林舟走向海岸。 ', '', '林舟走向海岸。', '林舟留在灯塔。'] } }
    const event = await x.commit(), saved = x.stories.snapshot(x.story.id)
    if (event.type !== 'turn.committed') throw new Error('Expected narrative commit')
    expect(event.data.extensions[namespace]).toEqual({ version: 1, options: ['林舟走向海岸。', '林舟留在灯塔。'] })
    expect(saved.messages.at(-1)?.text).toBe(prose)
    expect(saved.state.namespaces.story?.value).toEqual({ energy: 8 })
    expect(saved.replyOptions[x.messageId]).toEqual(['林舟走向海岸。', '林舟留在灯塔。'])
    expect(saved.maintenance['reply-options']).toBeUndefined()
    // Options cannot rewrite an already committed turn; retries return the original event.
    await Promise.all([x.commit(), x.commit({ ...x.input, extensions: { [namespace]: { options: ['后来想到的选项。'] } } })])
    expect(x.stories.snapshot(x.story.id)).toEqual(saved)
    expect(x.stories.eventsOfTypes(x.story.id, ['turn.committed'])).toHaveLength(1)
    expect(x.stories.eventsOfTypes(x.story.id, ['reply-options.ready', 'maintenance.status'])).toEqual([])
  })

  it.each([null, 'wrong shape', { options: [] }, { options: 'wrong shape' }, { options: ['usable', 42] }, { options: [' ', ''] }])('saves the core with a diagnostic for invalid advisory data %j', async value => {
    const x = setup(), event = await x.commit({ ...x.input, extensions: { [namespace]: value } })
    if (event.type !== 'turn.committed') throw new Error('Expected narrative commit')
    expect(event.data.extensions).toEqual({})
    expect(event.data.diagnostics).toEqual([expect.objectContaining({ code: 'RP_REPLY_OPTIONS_INVALID', source: namespace, severity: 'warning' })])
    const story = x.stories.snapshot(x.story.id)
    expect(story.messages.at(-1)?.text).toBe(prose)
    expect(story.state.namespaces.story?.value).toEqual({ energy: 8 })
    expect(story.maintenance['reply-options']).toMatchObject({ status: 'failed', messageId: x.messageId })
    expect(x.stories.eventsOfTypes(x.story.id, ['turn.committed'])).toHaveLength(1)
  })

  it('accepts an omitted extension without demanding a corrective model call', async () => {
    const x = setup(); delete x.input.extensions
    const event = await x.commit()
    if (event.type !== 'turn.committed') throw new Error('Expected narrative commit')
    expect(event.data.diagnostics?.[0]?.code).toBe('RP_REPLY_OPTIONS_INVALID')
    expect(x.stories.hasCommitted(x.run.id)).toBe(true)
  })

  it.each([undefined, { options: ['林舟走向海岸。'] }, { options: 'invalid' }])('discards options without a diagnostic when the feature is off (%j)', async value => {
    const x = setup(); x.preferences.enabled = false
    const event = await x.commit({ ...x.input, extensions: value === undefined ? {} : { [namespace]: value } })
    if (event.type !== 'turn.committed') throw new Error('Expected narrative commit')
    expect(event.data.extensions).toEqual({}); expect(event.data.diagnostics).toBeUndefined()
    expect(x.stories.snapshot(x.story.id).state.namespaces.story?.value).toEqual({ energy: 8 })
  })

  it('still rejects unknown extensions and invalid state, preserving options across a minimal repair', async () => {
    const x = setup(), before = x.stories.snapshot(x.story.id)
    await expect(x.commit({ ...x.input, extensions: { unexpected: {} } })).rejects.toMatchObject({ code: 'EXTENSION_UNAVAILABLE' })
    const invalid = structuredClone(x.input)
    ;(invalid.effects as JsonObject[])[0]!.expectedRevision = 99
    const failure = await x.commit(invalid).catch(error => error as RpError)
    expect(failure).toMatchObject({ code: 'STATE_REVISION_CONFLICT' })
    expect(x.stories.snapshot(x.story.id)).toEqual(before)
    const { retry } = (failure as RpError).details as { retry: { token: string } }
    await x.commit({ retry: { token: retry.token, patches: [{ op: 'replace', path: '/effects/0/expectedRevision', value: 1 }] } }, 'later-owner')
    const saved = x.stories.snapshot(x.story.id)
    expect(saved.messages.at(-1)?.id).toBe(x.messageId)
    expect(saved.replyOptions[x.messageId]).toEqual(['林舟走向海岸。', '林舟留在灯塔。'])
    expect(saved.state.namespaces.story?.value).toEqual({ energy: 8 })
  })

  it('stores Agent final prose and its choices together after Writer review', async () => {
    const x = setup('agent')
    await x.commit({ ...x.input, extensions: { [namespace]: { options: ['林舟沿着山路前行。'] } } }, x.messageId, '林舟转身走向山间。')
    const saved = x.stories.snapshot(x.story.id)
    expect(saved.messages.at(-1)?.text).toBe('林舟转身走向山间。')
    expect(saved.replyOptions[x.messageId]).toEqual(['林舟沿着山路前行。'])
  })

  it('checks cancellation before saving any part of the turn', async () => {
    const x = setup(), before = x.stories.snapshot(x.story.id)
    await expect(x.commit(x.input, x.messageId, prose, () => { throw new RpError('RUN_CANCELLED', '停止生成') })).rejects.toThrow('停止生成')
    expect(x.stories.snapshot(x.story.id)).toEqual(before)
    expect(x.stories.hasCommitted(x.run.id)).toBe(false)
  })

  it('replays choices across restart and fork, and retracts edited or removed owners', async () => {
    const x = setup(); await x.commit()
    recordModelReply(x.stories, x.run, x.messageId, prose)
    x.stories.setRunStatus(x.run.id, 'completed')
    const saved = x.stories.snapshot(x.story.id), branch = x.service.fork(saved.id, saved.revision, x.messageId)
    expect(branch.replyOptions).toEqual(saved.replyOptions)
    const reopened = new AppDatabase(x.filename)
    try { expect(new StoryRepository(reopened).snapshot(x.story.id).replyOptions).toEqual(saved.replyOptions) } finally { reopened.close() }
    expect(x.service.edit(saved.id, saved.revision, x.messageId, '林舟关上窗户。').replyOptions).toEqual({})
    expect(x.service.remove(branch.id, branch.revision, x.messageId).replyOptions).toEqual({})
  })
})
