import { requireStateNamespaceCapacity } from '../state/limits.ts'
import { compileStateCondition, evaluateStateCondition } from '../state/condition.js'
import { RP_STATE_PROTOCOL_VERSION } from '../state/definition.js'
import { parseJsonPointer } from '../state/json-pointer.js'
import { stateSchemaAtPointer } from '../state/schema.js'
import { stateUpdateEffectProtocol } from '../state/update.js'
import type { NamespaceSnapshot, StateRule, StoryState } from '../types.ts'

/** Writer sees current facts; the parent receives the exact update protocol and revisions. */
export function stateContext(state: StoryState) {
  const entries = Object.entries(state.namespaces)
  requireStateNamespaceCapacity(entries.length)
  return {
    text: entries.length ? JSON.stringify({ namespaces: entries.map(([namespace, snapshot]) => ({
      namespace, title: snapshot.definition.title, description: snapshot.definition.description, value: snapshot.value,
    })) }, null, 2) : '',
    parentText: JSON.stringify({ state_commit_contract: {
      version: 2, stateProtocolVersion: RP_STATE_PROTOCOL_VERSION,
      effectKind: 'state.update', effect: stateUpdateEffectProtocol(),
      constraints: [
        'Review the completed narrative against every applicable semantic rule and include its required changes. An optional effects parameter does not make applicable variable updates optional.',
        'Submit only paths whose values changed.', 'Submit at most one state.update effect per namespace.',
        'Paths in one effect must not duplicate, overlap, or contain one another.', 'All changes in one commit are atomic.',
        'Copy expectedRevision from the matching namespace in this contract, not the story revision. Changes contain JSON Pointers relative to that namespace; escape ~ as ~0 and / as ~1 in each key.',
        'when and guidance require narrative judgment; only condition is machine-evaluated. A supplied rule condition is checked immediately before its change, including earlier changes and earlier namespace effects in this commit.',
        'Review every applicable every-turn rule, but never invent a change when the value is unchanged. Omitted every-turn targets can produce a warning; the warning does not block a commit or require a no-op update.',
        'Use set/value, increment/by, append/value, or remove with no value/by. Increment minimum/maximum constrain by; resultSchema constrains the resulting number. valueSchema validates set.value or the appended item. For remove, parentSchema must still hold after removal, including required keys and minItems.',
      ],
      namespaces: entries.map(([namespace, snapshot]) => namespaceContract(namespace, snapshot)),
    } }),
  }
}

function namespaceContract(namespace: string, snapshot: NamespaceSnapshot) {
  const setup = snapshot.diagnostics.setup.filter(item => item.severity !== 'info')
  const lastCommit = snapshot.diagnostics.lastCommit.filter(item => item.severity !== 'info')
  return {
    namespace, expectedRevision: snapshot.revision, updateMode: snapshot.definition.updateMode,
    ruleIdRequirement: snapshot.definition.updateMode === 'rules-required' ? 'required' : snapshot.definition.updateMode === 'schema-only' ? 'optional' : 'updates-forbidden',
    title: snapshot.definition.title, description: snapshot.definition.description, currentValue: snapshot.value,
    ...(setup.length || lastCommit.length ? { diagnostics: { setup, lastCommit } } : {}),
    ...(snapshot.definition.updateMode === 'schema-only' ? { schema: snapshot.definition.schema } : {}),
    ...(snapshot.definition.updateMode === 'rules-required' || snapshot.definition.updateMode === 'schema-only' && snapshot.definition.rules.length > 0
      ? { rules: snapshot.definition.rules.map(rule => ruleContract(snapshot, rule)),
        ...(snapshot.definition.updateMode === 'schema-only' ? { ruleGuidance: 'Follow these semantic rules when deriving changes from the final narrative; ruleId is optional. Group guidance may describe child paths, but supplying its ruleId still requires exact target/op matching. Omit ruleId for such child changes and validate their resulting values against schema.' } : {}),
      } : {}),
  }
}

function ruleContract(snapshot: NamespaceSnapshot, rule: StateRule) {
  const segments = parseJsonPointer(rule.target, { allowRoot: true })
  const targetSchema = stateSchemaAtPointer(snapshot.definition.schema, segments)
  const valueSchema = rule.effect.op === 'set' ? targetSchema
    : rule.effect.op === 'append' && targetSchema?.items && typeof targetSchema.items === 'object' ? targetSchema.items : undefined
  return {
    ruleId: rule.id, target: rule.target, op: rule.effect.op,
    minimum: rule.effect.minimum, maximum: rule.effect.maximum, when: rule.when,
    condition: rule.condition, cadence: rule.cadence, guidance: rule.guidance, valueSchema,
    ...(rule.effect.op === 'increment' ? { resultSchema: targetSchema } : {}),
    ...(rule.effect.op === 'remove' ? { parentSchema: stateSchemaAtPointer(snapshot.definition.schema, segments.slice(0, -1)) } : {}),
  }
}

export function stateLoreActivation(state: StoryState) {
  return {
    gateEntry({ entry }: { entry: { stateCondition?: string } }) {
      if (entry.stateCondition === undefined) return undefined
      try {
        const evaluated = evaluateStateCondition(compileStateCondition(entry.stateCondition), state)
        return { active: evaluated.value, diagnostics: evaluated.diagnostics.map(item => ({ status: 'excluded', reason: 'state-condition', ...item })) }
      } catch (error) {
        return { active: false, diagnostics: [{ status: 'excluded', reason: 'state-condition-invalid', message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  }
}
