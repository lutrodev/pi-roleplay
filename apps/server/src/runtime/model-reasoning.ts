import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { ModelRegistration } from './models.ts'

const catalog = builtinModels()
type Identity = Pick<ModelRegistration, 'provider' | 'model' | 'api' | 'baseUrl'>
type Reasoning = Pick<Model<Api>, 'reasoning' | 'thinkingLevelMap' | 'compat'>

/** An exact catalog identity is evidence; a familiar substring or arbitrary alias is not. */
export function catalogReasoning(route: Identity): Reasoning | undefined {
  const matchesApi = (model: Model<Api>) => !route.api || model.api === route.api
    || model.provider === 'openai' && model.api === 'openai-responses' && route.api === 'openai-completions'
  const direct = catalog.getModel(route.provider, route.model)
  if (direct && matchesApi(direct)) return reasoningFields(direct, route.api)
  const candidates = catalog.getModels().filter(model => model.id === route.model && matchesApi(model))
  const endpoint = candidates.find(model => normalizeUrl(model.baseUrl) === normalizeUrl(route.baseUrl))
  if (endpoint) return reasoningFields(endpoint, route.api)
  // Native catalog entries avoid importing a gateway's different effort map into another gateway.
  const native = candidates.filter(model => ['openai', 'anthropic', 'deepseek', 'google', 'xai', 'moonshot', 'groq', 'mistral'].includes(model.provider))
  const choices = native.length ? native : candidates
  if (choices.length) {
    const first = reasoningFields(choices[0]!, route.api)
    if (choices.every(model => JSON.stringify(reasoningFields(model, route.api)) === JSON.stringify(first))) return first
  }
  // Pi 0.85.0 predates this entry. Exact, documented supplement; remove when the pinned catalog includes it.
  // https://developers.openai.com/api/docs/models/gpt-6-astra (verified 2026-09-08).
  if (route.model === 'gpt-6-astra' && (route.api === 'openai-completions' || route.api === 'openai-responses')) {
    return { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } }
  }
  return undefined
}

function reasoningFields(model: Model<Api>, api: ModelRegistration['api']): Reasoning {
  // These fields control reasoning dispatch. Other provider defaults stay with the configured connection.
  const compat = model.api === (api ?? model.api) ? Object.fromEntries(Object.entries(model.compat ?? {}).filter(([key]) =>
    ['thinkingFormat', 'supportsReasoningEffort', 'requiresReasoningContentOnAssistantMessages', 'forceAdaptiveThinking'].includes(key))) : {}
  return { reasoning: model.reasoning, ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(Object.keys(compat).length ? { compat } : {}) }
}

function normalizeUrl(value?: string) { return value?.replace(/\/+$/, '').replace(/\/v1$/, '') }

/** New reasoning routes start enabled; an explicit unsupported choice is never clamped. */
export function defaultThinkingLevel(model: Model<Api>): ModelThinkingLevel {
  const levels = getSupportedThinkingLevels(model)
  return (['medium', 'low', 'high', 'minimal', 'xhigh', 'max'] as const).find(level => levels.includes(level)) ?? 'off'
}
