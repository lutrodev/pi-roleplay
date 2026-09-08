import { afterEach, expect, it } from 'vitest'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { RunExecutor, type ExecutionResources } from '../apps/server/src/runtime/executor.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import { stateContext } from '../packages/rp-core/src/context/state.ts'
import { validateJsonSchemaValue } from '../packages/rp-core/src/validation.js'
import { fixture, profile } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(item => item.close()))
type Request = { messages: { role: string; content: unknown }[]; tools: { function: { name: string; parameters: object } }[] }
type Feedback = { details: { retry: { token: string }; issues: { code: string; path: string; details: { matchingRuleIds: string[] } }[] } }
const contentText = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(part => part && typeof part === 'object' && 'text' in part ? String(part.text) : '').join('\n') : ''

it.each(['chat', 'agent'] as const)('%s receives explicit State rules, repairs all missing IDs atomically, and continues with current values', async mode => {
  const x = fixture(); fixtures.push(x)
  const config = profile(); config.runtime.executionMode = mode
  const keys = ['time', 'location', 'expression', 'outfit']
  const initialValue = Object.fromEntries(keys.map(key => [key, 0]))
  const rules = keys.map((key, index) => ({ id: `mvu-rule-00${index + 1}`, target: `/${key}`, when: `推进 ${key}`, effect: { op: 'increment', minimum: 1, maximum: 1 } }))
  const entry = createNamespaceSnapshot({ initialValue, definition: { title: '合成规则', updateMode: 'rules-required', rules,
    schema: { type: 'object', properties: Object.fromEntries(keys.map(key => [key, { type: 'integer' }])), required: keys, additionalProperties: false } } })
  const story = x.stories.create('规则重试回归', config, { namespaces: { story: entry } })
  const service = new StoryService(x.stories, x.assets, x.files)
  const route = { provider: 'state-test', model: 'synthetic' }
  const requests: Request[] = [], tokens: string[] = [], faults: unknown[] = []
  const prose = '合成角色整理衣着，微笑着走到门前，时间过去了一分钟。'
  const effect = (revision: number, withIds: boolean) => ({ kind: 'state.update', namespace: 'story', expectedRevision: revision,
    payload: { changes: keys.map((key, index) => ({ op: 'increment', path: `/${key}`, by: 1, reason: `本轮推进 ${key}`, ...(withIds ? { ruleId: rules[index]!.id } : {}) })) } })
  const argumentsFor = (revision: number, withIds: boolean) => ({ runSummary: '场景推进', effects: [effect(revision, withIds)], ...(mode === 'agent' ? { narrative: prose } : {}) })
  const response = (index: number, call?: { name: string; args: object }) => new Response('data: ' + JSON.stringify({
    id: `response-${index}`, choices: [{ index: 0, delta: { role: 'assistant', content: call ? '' : prose,
      ...(call ? { tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }],
  }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  const registry = new ModelRegistry([{ ...route, keyEnv: 'STATE_TEST_KEY', api: 'openai-completions', baseUrl: 'https://state-test.invalid/v1', contextWindow: 100000, maxTokens: 4000 }], {
    env: () => 'synthetic-key', fetch: async (_url, init) => {
      try {
      const request = JSON.parse(String(init?.body)) as Request, index = requests.length
      requests.push(request)
      const text = request.messages.map(message => contentText(message.content)).join('\n')
      if (index === 0 || index === 5) {
        const current = x.stories.snapshot(story.id)
        expect(text).toContain(stateContext(current.state).parentText)
        expect(text).toContain('one successful rp_commit_turn')
        const schema = request.tools.find(tool => tool.function.name === 'rp_commit_turn')!.function.parameters
        expect(validateJsonSchemaValue(schema, { ...argumentsFor(1, false), extensions: { invented: true } })).not.toEqual([])
        expect(JSON.stringify(schema)).toContain('ruleIdRequirement')
        if (index === 5) expect(current.state.namespaces.story!.value).toEqual(Object.fromEntries(keys.map(key => [key, 1])))
        return response(index, { name: 'rp_write_turn', args: { action: 'write' } })
      }
      if (index === 1 || index === 6) {
        expect(text).not.toContain('state_commit_contract')
        expect(text).not.toContain('mvu-rule-001')
        return response(index)
      }
      if (index === 2) return response(index, { name: 'rp_commit_turn', args: argumentsFor(1, false) })
      if (index === 3 || index === 4) {
        const feedback = JSON.parse(contentText(request.messages.at(-1)!.content)) as Feedback
        expect(feedback.details.issues).toHaveLength(4)
        expect(feedback.details.issues.every(issue => issue.code === 'STATE_RULE_ID_REQUIRED')).toBe(true)
        expect(x.stories.snapshot(story.id).state.namespaces.story!.value).toEqual(initialValue)
        expect(x.stories.eventLog(story.id).filter(event => event.type === 'turn.committed')).toHaveLength(0)
        tokens.push(feedback.details.retry.token)
        const patches = index === 3 ? [] : feedback.details.issues.map((issue, changeIndex) => {
          expect(issue.path).toBe(`/effects/0/payload/changes/${changeIndex}/ruleId`)
          expect(issue.details.matchingRuleIds).toEqual([rules[changeIndex]!.id])
          return { op: 'add', path: issue.path, value: issue.details.matchingRuleIds[0] }
        })
        return response(index, { name: 'rp_commit_turn', args: { retry: { token: feedback.details.retry.token, patches } } })
      }
      if (index === 7) return response(index, { name: 'rp_commit_turn', args: argumentsFor(2, true) })
      throw new Error(`Unexpected model request ${index}`)
      } catch (error) { faults.push(error); throw error }
    },
  })
  const resources: ExecutionResources = { routes: { main: route, writer: route }, files: [], images: [], readonlyTools: [], specialists: [], tools: () => [] }
  const executor = new RunExecutor(x.stories, new ContextService(x.stories, x.assets), new TurnService(x.stories), registry, x.files)
  const queue = new RunQueue(x.stories, (id, signal) => executor.execute(id, signal, resources), error => faults.push(error))
  try {
    for (let turn = 1; turn <= 2; turn++) {
      const run = service.send(story.id, `request-${turn}`, [{ text: '继续合成场景。', attachmentIds: [] }]).run
      queue.wake(); await queue.idle()
      expect(faults).toEqual([])
      expect(x.stories.run(run.id).status).toBe('completed')
      expect(x.stories.snapshot(story.id).state.namespaces.story!.value).toEqual(Object.fromEntries(keys.map(key => [key, turn])))
    }
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).not.toBe(tokens[1])
    expect(requests).toHaveLength(8)
    const commits = x.stories.eventLog(story.id).filter(event => event.type === 'turn.committed')
    expect(commits).toHaveLength(2)
    expect(commits.every(event => event.data.message.text === prose)).toBe(true)
    expect(x.stories.eventLog(story.id).filter(event => event.type === 'writer.completed')).toHaveLength(2)
  } finally { await queue.close() }
})
