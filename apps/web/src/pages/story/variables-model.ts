import type { JsonObject, JsonValue, StoryState } from '../../../../../packages/rp-core/src/types.ts'
import { stateFields, type StateField } from '../../../../../packages/rp-core/src/display/state-fields.ts'

export interface VariableBoundary { before: StoryState; after: StoryState }
export interface VariableRow extends StateField {
  label: string
  change?: { kind: 'added' | 'updated' | 'removed'; before: JsonValue | undefined }
}
interface VariableGroup { path: string; title: string; rows: VariableRow[] }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function location(path: string, schema: JsonObject, value: JsonValue) {
  const keys = path ? path.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~')) : []
  const labels: string[] = []
  let node = value, definition = schema
  for (const key of keys) {
    definition = ((Array.isArray(node) ? definition.items : (definition.properties as JsonObject | undefined)?.[key]) as JsonObject | undefined) ?? {}
    labels.push(typeof definition.title === 'string' ? definition.title : key)
    node = node && typeof node === 'object' ? (node as JsonObject)[key]! : null
  }
  return { path: path.slice(0, path.lastIndexOf('/')), label: labels.pop() ?? String(schema.title ?? '值'), title: labels.join(' › ') }
}

/** Full displayed values are authoritative. A matching reply boundary only adds annotations. */
export function variableSections(state: StoryState, boundary?: VariableBoundary) {
  const ids = [...new Set([...Object.keys(state.namespaces), ...Object.keys(boundary?.before.namespaces ?? {})])]
  return ids.flatMap(id => {
    const current = state.namespaces[id], before = boundary?.before.namespaces[id], after = boundary?.after.namespaces[id]
    // Later edits and in-flight refreshes must not label historical changes as current.
    const comparable = !!boundary && (current && after ? current.revision === after.revision && equal(current.value, after.value) : !current && !after)
    if (!current && (!comparable || !before)) return []
    const snapshot = current ?? before!, schema = snapshot.definition.schema as unknown as JsonObject
    const fields = current ? stateFields(current.value as JsonValue, schema) : []
    const prior = comparable && before ? stateFields(before.value as JsonValue, before.definition.schema as unknown as JsonObject) : []
    const previous = new Map(prior.map(field => [field.path, field])), present = new Set(fields.map(field => field.path))
    const rows = [...fields, ...prior.filter(field => !present.has(field.path)).map(field => ({ ...field, value: undefined }))]
    const groups = new Map<string, VariableGroup>()
    for (const field of rows) {
      const old = previous.get(field.path), removed = !present.has(field.path)
      const position = location(field.path, removed ? before!.definition.schema as unknown as JsonObject : schema, (removed ? before! : snapshot).value as JsonValue)
      const group = groups.get(position.path) ?? { path: position.path, title: position.title, rows: [] }
      const change: VariableRow['change'] = comparable && (!old || removed || !equal(old.value, field.value)) ? { kind: removed ? 'removed' : old ? 'updated' : 'added', before: old?.value } : undefined
      group.rows.push({ ...field, label: position.label, ...(change ? { change } : {}) })
      groups.set(position.path, group)
    }
    return [{ id, snapshot, removed: !current, groups: [...groups.values()] }]
  })
}
