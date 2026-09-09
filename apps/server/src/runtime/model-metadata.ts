import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelRegistration } from './models.ts'
import { catalogCandidates, catalogReasoning } from './model-reasoning.ts'

export type MetadataSource = 'provider' | 'catalog' | 'manual' | 'unknown'
export type ModelMetadata = Pick<ModelRegistration, 'label' | 'input' | 'reasoning' | 'contextWindow' | 'maxTokens'> & Pick<Model<Api>, 'thinkingLevelMap' | 'compat'>
export type MetadataSources = Record<'label' | 'input' | 'reasoning' | 'contextWindow' | 'maxTokens', MetadataSource>
export type ModelIdentity = Pick<ModelRegistration, 'provider' | 'model' | 'api' | 'baseUrl'>

/** Exact identities only. Conflicting catalog entries cannot establish a specification. */
export function catalogMetadata(route: ModelIdentity): ModelMetadata {
  const candidates = catalogCandidates(route), result: ModelMetadata = { ...catalogReasoning(route) }
  for (const [field, key] of [['label', 'name'], ['input', 'input'], ['contextWindow', 'contextWindow'], ['maxTokens', 'maxTokens']] as const) {
    const value = candidates[0]?.[key]
    if (value !== undefined && candidates.every(model => JSON.stringify(model[key]) === JSON.stringify(value))) Object.assign(result, { [field]: value })
  }
  return result
}

/** An omitted override stays automatic, including after saving and restarting. */
export function resolveMetadata(registration: ModelRegistration, remote?: ModelMetadata) {
  const catalog = catalogMetadata(registration), sources = {} as MetadataSources
  const detected = { ...catalog, ...remote }
  const values = { label: registration.model, input: ['text'] as ('text' | 'image')[], reasoning: false, contextWindow: 128000, maxTokens: 8192 }
  for (const field of ['label', 'input', 'reasoning', 'contextWindow', 'maxTokens'] as const) {
    const manual = field === 'label' ? registration.label?.trim() || undefined : registration[field]
    sources[field] = manual !== undefined ? 'manual' : remote?.[field] !== undefined ? 'provider' : catalog[field] !== undefined ? 'catalog' : 'unknown'
    Object.assign(values, { [field]: manual ?? detected[field] ?? values[field] })
  }
  // This is the existing application budget for unlisted models, not a claimed provider limit.
  if (sources.maxTokens === 'unknown') values.maxTokens = Math.min(values.maxTokens, values.contextWindow)
  return { ...values, sources, thinkingLevelMap: detected.thinkingLevelMap, compat: { ...catalog.compat, ...remote?.compat } }
}
