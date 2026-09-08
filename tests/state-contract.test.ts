import { describe, expect, it } from 'vitest'
import { stateContext } from '../packages/rp-core/src/context/state.ts'
import { createNamespaceSnapshot } from '../packages/rp-core/src/state/definition.js'
import { applyStateChanges, stateUpdateEffectProtocol, stateUpdateEffectSchema } from '../packages/rp-core/src/state/update.js'
import { prepareStateEffects } from '../packages/rp-core/src/story/effects.ts'
import { applyCommitPatches, commitRetryParameterSchema, MAX_COMMIT_RETRY_PATCHES } from '../packages/rp-core/src/story/commit-retry.js'
import { validateJsonSchemaValue } from '../packages/rp-core/src/validation.js'
import type { NamespaceSnapshot, StateChange } from '../packages/rp-core/src/types.ts'

function snapshot(updateMode: 'rules-required' | 'schema-only' | 'disabled' = 'rules-required'): NamespaceSnapshot {
  return createNamespaceSnapshot({ initialValue: { score: 1, gate: true }, definition: {
    title: '合成规则', updateMode,
    schema: { type: 'object', properties: { score: { type: 'integer', maximum: 3 }, gate: { type: 'boolean' } }, required: ['score', 'gate'], additionalProperties: false },
    rules: [
      { id: 'raise-score', target: '/score', when: '完成目标后增加分数', effect: { op: 'increment', minimum: 1, maximum: 2 }, condition: 'state("story", "/gate") == true', cadence: 'every-turn' },
      { id: 'open-gate', target: '/gate', when: '打开门时', effect: { op: 'set' } },
    ],
  } })
}
const change: StateChange = { op: 'increment', path: '/score', by: 1, reason: '完成目标' }

describe('model-visible State contract matches domain enforcement', () => {
  it.each([
    ['rules-required', undefined, 'STATE_RULE_ID_REQUIRED'],
    ['rules-required', 'raise-score', null],
    ['schema-only', undefined, null],
    ['schema-only', 'raise-score', null],
    ['schema-only', 'unknown', 'STATE_RULE_UNKNOWN'],
    ['schema-only', 'open-gate', 'STATE_UPDATE_VALIDATION_FAILED'],
    ['disabled', undefined, 'STATE_NAMESPACE_UPDATE_DISABLED'],
    ['disabled', 'raise-score', 'STATE_NAMESPACE_UPDATE_DISABLED'],
  ] as const)('%s with ruleId=%s agrees with the advertised requirement', (mode, ruleId, code) => {
    const entry = snapshot(mode), state = { namespaces: { story: entry } }
    const contract = JSON.parse(stateContext(state).parentText).state_commit_contract
    expect(contract.namespaces[0].ruleIdRequirement).toBe(mode === 'rules-required' ? 'required' : mode === 'schema-only' ? 'optional' : 'updates-forbidden')
    expect(contract.effect.ruleId[mode]).toBeTruthy()
    for (const operation of Object.values(contract.effect.payload.changes.operations) as { optional?: string[]; conditional: string[] }[]) {
      expect(operation.optional).toBeUndefined()
      expect(operation.conditional).toContain('ruleId')
    }
    const apply = () => applyStateChanges({ state, namespace: 'story', snapshot: entry, changes: [{ ...change, ...(ruleId ? { ruleId } : {}) }] })
    if (code) expect(apply).toThrowError(expect.objectContaining({ code }))
    else expect(apply().result.value.score).toBe(2)
    expect(entry.value).toEqual({ score: 1, gate: true })
  })

  it('reports only exact path/op matches as missing-ID candidates without choosing a rule', () => {
    const entry = snapshot(), state = { namespaces: { story: entry } }
    for (const [input, matching] of [[change, ['raise-score']], [{ op: 'set', path: '/score', value: 2, reason: '重设' }, []]] as const) {
      expect(() => applyStateChanges({ state, namespace: 'story', snapshot: entry, changes: [input] })).toThrowError(expect.objectContaining({
        code: 'STATE_RULE_ID_REQUIRED', feedback: expect.objectContaining({ matchingRuleIds: matching }),
      }))
    }
  })

  it('checks supplied rule conditions in change order and enforces delta and final value limits', () => {
    const entry = snapshot('schema-only'); entry.value = { score: 1, gate: false }
    const rule = JSON.parse(stateContext({ namespaces: { story: entry } }).parentText).state_commit_contract.namespaces[0].rules[0]
    expect(rule).toMatchObject({ minimum: 1, maximum: 2, resultSchema: { type: 'integer', maximum: 3 } })
    const apply = (changes: StateChange[]) => applyStateChanges({ state: { namespaces: { story: entry } }, namespace: 'story', snapshot: entry, changes })
    const score = { ...change, ruleId: 'raise-score' }
    const gate: StateChange = { op: 'set', path: '/gate', value: true, reason: '打开门' }
    expect(() => apply([score, gate])).toThrowError(expect.objectContaining({ code: 'STATE_RULE_CONDITION_UNSATISFIED' }))
    expect(apply([gate, score]).result.value).toEqual({ score: 2, gate: true })
    expect(() => apply([gate, { ...score, by: 3 }])).toThrowError(expect.objectContaining({ code: 'STATE_RULE_INCREMENT_ABOVE_MAXIMUM' }))
    entry.value = { score: 2, gate: true }
    expect(() => apply([{ ...score, by: 2 }])).toThrowError(expect.objectContaining({ code: 'STATE_RESULT_SCHEMA_INVALID' }))
    expect(apply([{ ...change, by: -1 }]).result.value.score).toBe(1)
  })

  it('exposes the required-key constraint that blocks a remove rule', () => {
    const entry = snapshot()
    entry.definition.rules = [{ id: 'remove-score', target: '/score', when: '移除分数', effect: { op: 'remove' }, guidance: [], cadence: 'when-applicable' }]
    const state = { namespaces: { story: entry } }
    const rule = JSON.parse(stateContext(state).parentText).state_commit_contract.namespaces[0].rules[0]
    expect(rule.parentSchema.required).toContain('score')
    expect(() => applyStateChanges({ state, namespace: 'story', snapshot: entry,
      changes: [{ op: 'remove', path: '/score', ruleId: 'remove-score', reason: '移除分数' }] })).toThrowError(expect.objectContaining({ code: 'STATE_RESULT_SCHEMA_INVALID' }))
  })

  it('allows unchanged values with every-turn warnings instead of requiring no-op writes', () => {
    const entry = snapshot(), state = { namespaces: { story: entry } }
    const prepared = prepareStateEffects(state, [])
    expect(prepared.effects).toEqual([])
    expect(prepared.state.namespaces.story!.value).toEqual(entry.value)
    expect(prepared.diagnostics).toContainEqual(expect.objectContaining({ code: 'STATE_EVERY_TURN_MISSED', severity: 'warning' }))
    expect(entry.diagnostics.lastCommit).toEqual([])
  })

  it('publishes nonempty change lists and complete object replacement, matching application behavior', () => {
    const effect = { kind: 'state.update', namespace: 'story', expectedRevision: 1, payload: { changes: [] } }
    expect(stateUpdateEffectProtocol().payload.changes.minItems).toBe(1)
    expect(validateJsonSchemaValue(stateUpdateEffectSchema(), effect)).not.toEqual([])
    expect(() => applyStateChanges({ state: { namespaces: { story: snapshot() } }, namespace: 'story', snapshot: snapshot(), changes: [] })).toThrow()
    const entry = createNamespaceSnapshot({ initialValue: { group: { old: 1 } }, definition: { title: '对象替换', updateMode: 'schema-only', rules: [],
      schema: { type: 'object', properties: { group: { type: 'object', additionalProperties: true } }, required: ['group'], additionalProperties: false } } })
    const apply = (value: object) => applyStateChanges({ state: { namespaces: { story: entry } }, namespace: 'story', snapshot: entry,
      changes: [{ op: 'set', path: '/group', value, reason: '替换整个分组' }] })
    expect(apply({ next: 2 }).result.value).toEqual({ group: { next: 2 } })
  })

  it('distinguishes adding missing retry fields from replacing existing ones and bounds patch counts', () => {
    const draft = { effects: [{ payload: { changes: [change] } }] }, path = '/effects/0/payload/changes/0/ruleId'
    expect(() => applyCommitPatches(draft, [{ op: 'replace', path, value: 'raise-score' }])).toThrow('does not exist')
    expect(applyCommitPatches(draft, [{ op: 'add', path, value: 'raise-score' }]).effects[0].payload.changes[0].ruleId).toBe('raise-score')
    expect(applyCommitPatches(draft, [])).toEqual(draft)
    const schema = commitRetryParameterSchema()
    expect(validateJsonSchemaValue(schema, { token: 'latest', patches: [] })).toEqual([])
    expect(validateJsonSchemaValue(schema, { token: 'latest', patches: Array.from({ length: MAX_COMMIT_RETRY_PATCHES + 1 }, () => ({ op: 'add', path, value: 'raise-score' })) })).not.toEqual([])
  })
})
