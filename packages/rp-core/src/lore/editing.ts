import type { JsonObject } from '../types.ts'

export function orderEntries(entries: JsonObject[]): JsonObject[] {
  const order = new Map<string, number>()
  return entries.map(entry => {
    const level = String(entry.level ?? 'worldDescription'), next = order.get(level) ?? 0
    order.set(level, next + 1)
    return { ...entry, order: next }
  })
}
export function moveEntry(entries: JsonObject[], index: number, by: -1 | 1, preset = false) {
  let target = index + by
  const category = (entry: JsonObject) => preset ? entry.position ?? 'top' : entry.level ?? 'worldDescription'
  while (target >= 0 && target < entries.length && category(entries[target]!) !== category(entries[index]!)) target += by
  if (target < 0 || target >= entries.length) return entries
  const next = [...entries]; [next[index], next[target]] = [next[target]!, next[index]!]
  return preset ? next : orderEntries(next)
}
/** Reorder the visible subset in place; hidden entries and other categories retain their positions. */
export function reorderEntries(entries: JsonObject[], ids: string[], preset = false) {
  const selected = new Set(ids), byId = new Map(entries.map(entry => [String(entry.id), entry]))
  let index = 0
  const next = entries.map(entry => selected.has(String(entry.id)) ? byId.get(ids[index++]!)! : entry)
  return preset ? next : orderEntries(next)
}
/** New or relocated preset fields go to the end of their destination group. */
export function insertPresetField(entries: JsonObject[], field: JsonObject) {
  const position = field.position ?? 'top', next = entries.filter(entry => entry.id !== field.id)
  const last = next.findLastIndex(entry => (entry.position ?? 'top') === position)
  next.splice(last < 0 ? position === 'top' ? 0 : next.length : last + 1, 0, field)
  return next
}
export function changePresetPosition(entries: JsonObject[], id: string, position: 'top' | 'bottom') {
  const field = entries.find(entry => entry.id === id)
  if (!field || (field.position ?? 'top') === position) return entries
  return insertPresetField(entries, { ...field, position })
}
export function matchesEntry(entry: JsonObject, query: string, enabled: string, level: string) {
  return (enabled === 'all' || (entry.enabled !== false) === (enabled === 'enabled')) && (!level || entry.level === level) &&
    [entry.name, entry.content, ...(Array.isArray(entry.keys) ? entry.keys : []), ...(Array.isArray(entry.secondaryKeys) ? entry.secondaryKeys : [])].join('\n').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
}
