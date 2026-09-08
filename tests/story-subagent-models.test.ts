import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { normalizeProfile } from '../packages/rp-core/src/story/profile.js'
import { normalizeSubagentRoutes, storySubagentCatalog } from '../packages/rp-core/src/agents/session-routes.ts'
import { SubagentService } from '../apps/server/src/services/subagent-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { StoryRepository } from '../apps/server/src/storage/story-repository.ts'
import { projectStory } from '../packages/rp-core/src/story/projection.ts'
import { fixture, message, profile } from './helpers.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
const fixed = (model: string) => ({ kind: 'fixed' as const, provider: 'test', model, reasoningEffort: 'low' })
function setup() {
  const x = fixture(); cleanup.push(x.close)
  const models = new ModelRegistry(['global', 'local', 'updated'].map(model => ({ provider: 'test', model, reasoning: true,
    keyEnv: 'SYNTHETIC', api: 'openai-completions' as const, baseUrl: 'https://model.test/v1', contextWindow: 32000, maxTokens: 4096 })), { env: () => 'synthetic-key' })
  return { ...x, models, catalog: new SubagentService(x.assets, models), service: new StoryService(x.stories, x.assets, x.files) }
}

it('keeps per-story model overrides in the event log, independent from defaults and other stories, including replay, reopen and fork', () => {
  const x = setup(), catalog = x.catalog.snapshot(), task = catalog.subagents[0]!
  const original = x.service.create('当前会话'), other = x.service.create('另一会话')
  const runtime = { ...original.profile.runtime, writerRoute: fixed('local'), subagentRoutes: { [task.id]: fixed('local') } }
  const saved = x.service.updateProfile(original.id, original.revision, { ...original.profile, runtime })
  expect(x.stories.eventLog(original.id).at(-1)?.type).toBe('profile.changed')
  expect(saved.profile.runtime).toEqual(runtime)
  expect(projectStory(x.stories.eventLog(original.id)).profile.runtime).toEqual(runtime)
  expect(x.stories.snapshot(other.id).profile.runtime.subagentRoutes).toBeUndefined()
  expect(x.catalog.snapshot()).toEqual(catalog)
  const opening = message('assistant', '一封信。')
  x.stories.append(saved.id, { type: 'message.added', data: { message: opening } })
  const branch = x.service.fork(saved.id, x.stories.snapshot(saved.id).revision, opening.id)
  expect(branch.profile.runtime).toEqual(runtime)
  const reset = x.service.updateProfile(branch.id, branch.revision, { ...branch.profile, runtime: { executionMode: 'chat' } })
  expect(reset.profile.runtime.writerRoute).toBeUndefined()
  expect(x.stories.snapshot(saved.id).profile.runtime).toEqual(runtime)
  x.database.close()
  const reopened = new AppDatabase(x.filename)
  try { expect(new StoryRepository(reopened).snapshot(saved.id).profile.runtime).toEqual(runtime) }
  finally { reopened.close() }
})

it('follows live global routes until overridden, preserves explicit main inheritance and does not resurrect deleted agents', () => {
  const x = setup(), catalog = x.catalog.snapshot(), plan = catalog.subagents[0]!, polish = catalog.subagents[1]!
  const body = (agent: typeof plan, model: string) => ({ name: agent.name, description: agent.description, instructions: agent.instructions,
    tools: agent.tools, enabled: agent.enabled, route: fixed(model) })
  x.catalog.update(plan.id, plan.revision, body(plan, 'global'))
  x.catalog.update(polish.id, polish.revision, body(polish, 'global'))
  x.catalog.updateWriter(catalog.writer.revision, fixed('global'))
  const runtime = { executionMode: 'agent' as const, writerRoute: { kind: 'inherit' as const },
    subagentRoutes: { [plan.id]: fixed('local'), [polish.id]: { kind: 'inherit' as const } } }
  const frozen = storySubagentCatalog(x.catalog.snapshot(), runtime)
  expect(frozen.writer.route).toEqual({ kind: 'inherit' })
  expect(frozen.subagents.map(agent => agent.route)).toEqual([fixed('local'), { kind: 'inherit' }])
  const current = x.catalog.snapshot().subagents[0]!
  x.catalog.update(current.id, current.revision, body(current, 'updated'))
  expect(storySubagentCatalog(x.catalog.snapshot(), { executionMode: 'agent' }).subagents[0]!.route).toEqual(fixed('updated'))
  expect(storySubagentCatalog(x.catalog.snapshot(), runtime).subagents.map(agent => agent.route)).toEqual(frozen.subagents.map(agent => agent.route))
  expect(frozen.subagents[0]!.revision).toBe(2)
  const deleted = x.catalog.snapshot().subagents[0]!
  x.catalog.remove(deleted.id, deleted.revision)
  expect(storySubagentCatalog(x.catalog.snapshot(), runtime).subagents.map(agent => agent.id)).toEqual([polish.id])
  expect(frozen.subagents).toHaveLength(2)
})

it('rejects malformed and excessive overrides atomically, and protects concurrent or busy story settings', () => {
  const x = setup(), story = x.service.create('设置校验'), id = x.catalog.snapshot().subagents[0]!.id
  for (const input of [[], null, { planning: fixed('local') }, { [id]: { kind: 'inherit', model: 'local' } }, { [id]: { kind: 'fixed', provider: 'test' } }, { [id]: { ...fixed('local'), reasoningEffort: 7 } }]) {
    expect(() => normalizeProfile({ ...story.profile, runtime: { executionMode: 'agent', subagentRoutes: input } }, story.profile.revision)).toThrow()
    expect(x.stories.snapshot(story.id)).toEqual(story)
  }
  const boundary = Object.fromEntries(Array.from({ length: 32 }, () => [randomUUID(), fixed('local')]))
  expect(Object.keys(normalizeSubagentRoutes(boundary))).toHaveLength(32)
  expect(() => normalizeSubagentRoutes({ ...boundary, [randomUUID()]: fixed('local') })).toThrow('32')
  expect(normalizeProfile({ ...profile(), runtime: { subagentRoutes: {} } }, 0).runtime.subagentRoutes).toBeUndefined()
  const updated = x.service.updateProfile(story.id, story.revision, { ...story.profile, runtime: { executionMode: 'agent', subagentRoutes: { [id]: fixed('local') } } })
  expect(() => x.service.updateProfile(story.id, story.revision, story.profile)).toThrow('更新')
  x.service.send(story.id, 'busy-settings', [{ text: '继续', attachmentIds: [] }])
  expect(() => x.service.updateProfile(story.id, x.stories.snapshot(story.id).revision, updated.profile)).toThrow('等待')
})
