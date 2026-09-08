import { afterEach, describe, expect, it } from 'vitest'
import { SubagentService } from '../apps/server/src/services/subagent-service.ts'
import { ModelRegistry, type ModelRegistration } from '../apps/server/src/runtime/models.ts'
import { fixture } from './helpers.ts'

const clean: (() => void)[] = []
afterEach(() => clean.splice(0).forEach(close => close()))
const model: ModelRegistration = { provider: 'test', model: 'task', keyEnv: 'TEST_TASK_KEY', api: 'openai-completions', baseUrl: 'https://model.test/v1', contextWindow: 32000, maxTokens: 4096, reasoning: true }
function setup() {
  const x = fixture(); clean.push(x.close)
  const models = new ModelRegistry([model], { env: () => 'synthetic-key' })
  return { ...x, models, service: new SubagentService(x.assets, models) }
}
const body = { name: '校对', description: '按需校对任务明确给出的材料。', instructions: '返回明确发现的问题及修正候选。', enabled: true, route: { kind: 'inherit' }, tools: [] }

describe('durable isolated task catalog', () => {
  it('initializes the reviewed examples once and preserves deletion and disabled choices across service recreation', () => {
    const x = setup(), first = x.service.snapshot()
    expect(first.subagents.map(item => item.name)).toEqual(['规划', '润色'])
    x.service.setEnabled(first.subagents[0]!.id, 1, false)
    expect(new SubagentService(x.assets, x.models).snapshot().subagents[0]?.enabled).toBe(false)
    for (const item of x.service.snapshot().subagents) x.service.remove(item.id, item.revision)
    expect(new SubagentService(x.assets, x.models).snapshot().subagents).toEqual([])
    expect(first.subagents).toHaveLength(2)
  })

  it('keeps Writer fixed and uses revision conflicts and normalized unique names for editable tasks', () => {
    const x = setup(), task = x.service.create(body)
    expect(() => x.service.create({ ...body, name: '校对' })).toThrow('同名')
    x.service.create({ ...body, name: 'Review' })
    expect(() => x.service.create({ ...body, name: 'Ｒｅｖｉｅｗ' })).toThrow('同名')
    const updated = x.service.update(task.id, 1, { ...body, description: '仅做拼写校对。' })
    expect(updated.revision).toBe(2)
    expect(() => x.service.remove(task.id, 1)).toThrow('已经更新')
    expect(() => x.service.setEnabled('writer', 1, false)).toThrow('固定 Writer')
    expect(() => x.service.remove('writer', 1)).toThrow('固定 Writer')
  })

  it('validates fixed routes and allowed tools without silently downgrading capabilities', () => {
    const x = setup()
    const route = { kind: 'fixed', provider: model.provider, model: model.model, reasoningEffort: 'high' }
    expect(x.service.updateWriter(1, route).route).toEqual(route)
    expect(() => x.service.updateWriter(1, { kind: 'inherit' })).toThrow('已经更新')
    expect(() => x.service.create({ ...body, route: { ...route, reasoningEffort: 'nonsense' } })).toThrow('思考强度')
    expect(() => x.service.create({ ...body, tools: ['bash'] })).toThrow('可选工具')
    expect(() => x.service.create({ ...body, tools: ['skill', 'skill'] })).toThrow('可选工具')
    expect(() => x.service.create({ ...body, instructions: 'x'.repeat(20001) })).toThrow('20000')
  })

  it('reports corrupted settings instead of silently recreating the catalog', () => {
    const x = setup()
    x.assets.setSetting('subagents.catalog', { version: 999, subagents: [] })
    expect(() => x.service.snapshot()).toThrow('已损坏')
    expect(x.assets.getSetting('subagents.catalog')).toEqual({ version: 999, subagents: [] })
  })
})
