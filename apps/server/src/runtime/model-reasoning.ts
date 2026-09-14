import { type Api, type Model } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { ModelRegistration } from './models.ts'
import { sameModelEndpoint } from './model-endpoint.ts'

const catalog = builtinModels()
const byId = new Map<string, Model<Api>[]>()
for (const model of catalog.getModels()) byId.set(model.id, [...(byId.get(model.id) ?? []), model])
type Identity = Pick<ModelRegistration, 'provider' | 'model' | 'api' | 'baseUrl'>
type Reasoning = Pick<Model<Api>, 'reasoning' | 'thinkingLevelMap' | 'compat'>

/** An exact catalog identity is evidence; a familiar substring or arbitrary alias is not. */
export function catalogReasoning(route: Identity): Reasoning | undefined {
  const choices = catalogCandidates(route)
  if (choices.length) {
    const first = reasoningFields(choices[0]!, route)
    if (choices.every(model => JSON.stringify(reasoningFields(model, route)) === JSON.stringify(first))) return first
  }
  // Pi 0.85.0 predates this entry. Exact, documented supplement; remove when the pinned catalog includes it.
  // https://developers.openai.com/api/docs/models/gpt-6-astra (verified 2026-09-08).
  if (route.model === 'gpt-6-astra' && (route.api === 'openai-completions' || route.api === 'openai-responses')) {
    return { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } }
  }
  return undefined
}

export function catalogCandidates(route: Identity): Model<Api>[] {
  const matchesApi = (model: Model<Api>) => !route.api || model.api === route.api
    || model.provider === 'openai' && model.api === 'openai-responses' && route.api === 'openai-completions'
  const direct = catalog.getModel(route.provider, route.model)
  if (direct && matchesApi(direct)) return [direct]
  const candidates = (byId.get(route.model) ?? []).filter(matchesApi)
  const endpoint = candidates.find(model => sameModelEndpoint(model, route))
  if (endpoint) return [endpoint]
  // Native catalog entries avoid importing a gateway's different effort map into another gateway.
  const native = candidates.filter(model => ['openai', 'anthropic', 'deepseek', 'google', 'xai', 'moonshot', 'groq', 'mistral'].includes(model.provider))
  return native.length ? native : candidates
}

function reasoningFields(model: Model<Api>, route: Identity): Reasoning {
  const native = model.api === (route.api ?? model.api) && (sameModelEndpoint(model, route) || !route.baseUrl && route.provider === model.provider)
  // A generated connection ID must not discard the exact endpoint's protocol capabilities.
  // An unrecognized gateway does not inherit the native provider's compatibility dialect.
  const compat = native ? model.compat : undefined
  return { reasoning: model.reasoning, ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(compat && Object.keys(compat).length ? { compat } : {}) }
}
