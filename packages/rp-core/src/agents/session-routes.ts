import type { ModelSelection, SubagentCatalog } from './catalog.ts'
import type { StoryProfile } from '../types.ts'

export function normalizeSessionModelRoute(input: unknown): ModelSelection {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Model route must be an object')
  const route = input as Record<string, unknown>
  if (route.kind === 'inherit' && Object.keys(route).length === 1) return { kind: 'inherit' }
  if (route.kind !== 'fixed' || Object.keys(route).some(key => !['kind', 'provider', 'model', 'reasoningEffort'].includes(key))) throw new Error('Model route must select inherit or a complete fixed model')
  const text = (value: unknown, max: number) => {
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max) throw new Error('Model route contains an invalid field')
    return value.trim()
  }
  return { kind: 'fixed', provider: text(route.provider, 64), model: text(route.model, 200),
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: text(route.reasoningEffort, 64) }) }
}

/** Only explicit per-story choices are persisted. Missing entries keep following the live global catalog. */
export function normalizeSubagentRoutes(input: unknown): Record<string, ModelSelection> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('runtime.subagentRoutes must be an object')
  const entries = Object.entries(input)
  if (entries.length > 32) throw new Error('runtime.subagentRoutes cannot contain more than 32 task models')
  return Object.fromEntries(entries.map(([id, route]) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('runtime.subagentRoutes requires valid task IDs')
    return [id, normalizeSessionModelRoute(route)]
  }))
}

export function storySubagentCatalog(catalog: SubagentCatalog, runtime: StoryProfile['runtime']): SubagentCatalog {
  return {
    writer: { ...catalog.writer, route: structuredClone(runtime.writerRoute ?? catalog.writer.route) },
    version: catalog.version,
    subagents: catalog.subagents.map(agent => ({ ...structuredClone(agent), route: structuredClone(runtime.subagentRoutes?.[agent.id] ?? agent.route) })),
  }
}
