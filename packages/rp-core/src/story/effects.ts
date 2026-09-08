import { RpError, requireValue } from '../errors.ts'
import { compileStateCondition, evaluateStateCondition } from '../state/condition.js'
import { applyStateChanges, stateUpdateEffectSchema } from '../state/update.js'
import { validateJsonSchemaValue } from '../validation.js'
import type { JsonObject, StateEffect, StateUpdate, StoryState } from '../types.ts'
import { commitIssues, rejectCommitIssues, type CommitIssue } from './commit-issues.ts'

const effectSchema = stateUpdateEffectSchema()

/** Prepare all effects against a private copy. No partial state escapes a failed commit. */
export function prepareStateEffects(state: StoryState, input: unknown) {
  requireValue(Array.isArray(input) && input.length <= 64, 'INVALID_EFFECTS', '每次剧情提交最多包含 64 项变量更新。')
  const working = structuredClone(state)
  const accepted: StateEffect[] = []
  const changed = new Set<string>()
  const issues: CommitIssue[] = [], seen = new Set<string>()
  for (const [index, candidate] of input.entries()) {
    try {
      const schemaIssues = validateJsonSchemaValue(effectSchema, candidate)
      if (schemaIssues.length) throw new RpError('INVALID_EFFECTS', '变量更新格式不正确，请修正后重新提交。', 400, schemaIssues)
      const effect = candidate as StateEffect
      if (seen.has(effect.namespace)) throw new RpError('DUPLICATE_STATE_EFFECT', '一次剧情提交只能对同一变量组提交一项更新。', 400, [{ path: '/namespace' }])
      seen.add(effect.namespace)
      const snapshot = working.namespaces[effect.namespace]
      if (!snapshot) throw new RpError('STATE_NOT_FOUND', '要更新的变量组已不存在，请重新读取当前变量。', 409, [{ path: '/namespace' }])
      if (snapshot.revision !== effect.expectedRevision) throw new RpError('STATE_REVISION_CONFLICT', '变量已发生变化，请根据最新值重新提交。', 409, [{ path: '/expectedRevision' }])
      let prepared: ReturnType<typeof applyStateChanges>
      try { prepared = applyStateChanges({ state: working, namespace: effect.namespace, snapshot, changes: effect.payload.changes }) }
      catch (error) {
        throw new RpError('STATE_UPDATE_INVALID', '变量更新不符合当前规则，剧情尚未提交。', 400,
          error && typeof error === 'object' && 'issues' in error ? error.issues : error instanceof Error ? error.message : undefined)
      }
      working.namespaces[effect.namespace] = prepared.result
      accepted.push({ ...effect, payload: { changes: prepared.changes as StateEffect['payload']['changes'] } })
      changed.add(effect.namespace)
    } catch (error) {
      issues.push(...commitIssues(error, `/effects/${index}`))
    }
  }
  rejectCommitIssues(issues)
  const diagnostics: JsonObject[] = []
  for (const [namespace, snapshot] of Object.entries(state.namespaces)) {
    const currentDiagnostics: JsonObject[] = []
    if (snapshot.definition.updateMode !== 'disabled') {
      const changes = accepted.filter(effect => effect.namespace === namespace).flatMap(effect => effect.payload.changes)
      for (const rule of snapshot.definition.rules.filter(item => item.cadence === 'every-turn')) {
        if (rule.condition) {
          const evaluated = evaluateStateCondition(compileStateCondition(rule.condition), state)
          if (!evaluated.value) {
            currentDiagnostics.push(...evaluated.diagnostics.map(item => ({ ...item, namespace, ruleId: rule.id, path: rule.target })))
            continue
          }
        }
        if (!changes.some(change => change.path === rule.target && (snapshot.definition.updateMode === 'schema-only' || change.ruleId === rule.id))) {
          currentDiagnostics.push({ code: 'STATE_EVERY_TURN_MISSED', severity: 'warning', namespace, ruleId: rule.id, path: rule.target, message: `本轮未检查规则“${rule.when}”对应的变量。` })
        }
      }
    }
    if (currentDiagnostics.length || snapshot.diagnostics.lastCommit.length) {
      const target = working.namespaces[namespace]!
      target.diagnostics = { ...target.diagnostics, lastCommit: currentDiagnostics }
      changed.add(namespace)
    }
    diagnostics.push(...currentDiagnostics)
  }
  const updates: StateUpdate[] = [...changed].map(namespace => ({ namespace, snapshot: working.namespaces[namespace]! }))
  return { effects: accepted, state: working, updates, diagnostics }
}
