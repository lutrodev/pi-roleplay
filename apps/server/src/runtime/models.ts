import { type Api, type Context, type ImageContent, type Model, type ModelThinkingLevel, type ProviderStreams, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { ModelRoute, StoryProfile } from '../../../../packages/rp-core/src/types.ts'
import { resolveModelSelection, type ModelSelection } from '../../../../packages/rp-core/src/agents/catalog.ts'
import { describeReasoning, resolveReasoning } from './reasoning-controls.ts'
import { applyReasoningPayload, reasoningParameters } from './reasoning-payload.ts'
import type { ReasoningControlConfig, ReasoningDescriptor } from '../../../../packages/protocol/src/reasoning.ts'
import { resolveMetadata, type ModelIdentity, type ModelMetadata, type MetadataSources } from './model-metadata.ts'
import { ModelRequestQueue } from './model-request-queue.ts'
import { modelBaseUrl } from './model-endpoint.ts'
import { prepareReasoningRequest } from './reasoning-request.ts'
import { requireReasoningBudget, thinkingBudget } from './reasoning-budget.ts'

export interface ModelRegistration {
  provider: string
  model: string
  label?: string
  keyEnv: string
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  baseUrl?: string
  contextWindow?: number
  maxTokens?: number
  input?: ('text' | 'image')[]
  /** Omitted means automatic metadata detection; booleans are explicit overrides. */
  reasoning?: boolean
  reasoningControl?: ReasoningControlConfig
  defaultReasoningEffort?: string
  outputTokens?: number
  temperature?: number
  compat?: Model<Api>['compat']
}

export interface ModelStreamOptions extends SimpleStreamOptions {
  reasoningSelection?: string
  onQueued?: (queued: boolean) => void
  onRequestParameters?: (parameters: Record<string, unknown>) => void
}
interface RegisteredModel { registration: ModelRegistration; model: Model<Api>; streams: ProviderStreams; sources: MetadataSources; providerLabel: string; reasoning: ReasoningDescriptor }

/** Only explicitly configured routes are available. Secrets are resolved at request time and never returned by list(). */
export class ModelRegistry {
  private entries = new Map<string, RegisteredModel>()
  private readonly requests: ModelRequestQueue
  constructor(registrations: ModelRegistration[], readonly options: {
    env?: (key: string) => string | undefined
    fetch?: SimpleStreamOptions['fetch']
    metadata?: (route: ModelIdentity) => ModelMetadata | undefined
    providerLabel?: (provider: string) => string
    requests?: ModelRequestQueue
  } = {}) {
    this.requests = options.requests ?? new ModelRequestQueue()
    requireValue(Array.isArray(registrations) && registrations.length <= 64, 'MODEL_CONFIG_INVALID', '最多配置 64 个模型。')
    const builtins = builtinModels()
    const customApis: Record<string, ProviderStreams> = {
      'openai-completions': openAICompletionsApi(), 'openai-responses': openAIResponsesApi(), 'anthropic-messages': anthropicMessagesApi(),
    }
    for (const registration of registrations) {
      requireValue(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(registration.provider) && typeof registration.model === 'string' && registration.model.length > 0 && registration.model.length <= 200,
        'MODEL_CONFIG_INVALID', '模型提供商或模型名称不正确。')
      requireValue(typeof registration.keyEnv === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(registration.keyEnv), 'MODEL_CONFIG_INVALID', '模型密钥需要引用一个环境变量名。')
      const key = routeKey(registration)
      requireValue(!this.entries.has(key), 'MODEL_CONFIG_INVALID', '同一个提供商和模型不能重复配置。')
      const known = builtins.getModel(registration.provider, registration.model)
      const detected = resolveMetadata(registration, options.metadata?.(registration))
      requireValue(known || (registration.api && registration.baseUrl),
        'MODEL_CONFIG_INVALID', '目录之外的模型需要配置 API 类型和地址。')
      const model: Model<Api> = {
        id: registration.model, provider: registration.provider, name: detected.label,
        api: registration.api ?? known!.api, baseUrl: registration.baseUrl ?? known!.baseUrl,
        contextWindow: detected.contextWindow, maxTokens: detected.maxTokens,
        input: detected.input, reasoning: detected.reasoning,
        cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { ...detected.compat, ...registration.compat },
        ...(detected?.thinkingLevelMap ? { thinkingLevelMap: detected.thinkingLevelMap } : {}),
      }
      let url: URL | undefined
      try { url = new URL(model.baseUrl) } catch { /* validation below */ }
      requireValue(url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
        'MODEL_CONFIG_INVALID', '模型地址必须为 HTTP(S) 地址，不能携带凭据或查询参数。')
      model.baseUrl = modelBaseUrl(model.api, model.baseUrl)
      requireValue(Number.isSafeInteger(model.contextWindow) && model.contextWindow >= 1024 && Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 && model.maxTokens <= model.contextWindow,
        'MODEL_CONFIG_INVALID', '上下文窗口或输出上限不正确。')
      requireValue(Array.isArray(model.input) && model.input.includes('text') && model.input.every(type => type === 'text' || type === 'image'), 'MODEL_CONFIG_INVALID', '模型输入能力不正确。')
      requireValue(registration.outputTokens === undefined || (Number.isSafeInteger(registration.outputTokens) && registration.outputTokens > 0 && registration.outputTokens <= model.maxTokens),
        'MODEL_CONFIG_INVALID', '本项目的输出限制不能超过模型的输出上限。')
      requireValue(registration.temperature === undefined || (Number.isFinite(registration.temperature) && registration.temperature >= 0 && registration.temperature <= 2),
        'MODEL_CONFIG_INVALID', 'temperature 必须在 0 到 2 之间。')
      const provider = known && !registration.api ? builtins.getProvider(registration.provider) : undefined
      const streams = provider ?? customApis[model.api]
      requireValue(streams, 'MODEL_CONFIG_INVALID', '这个模型 API 暂不可用。')
      const reasoning = describeReasoning(registration, model, options.metadata?.(registration))
      this.entries.set(key, { registration: structuredClone(registration), model, streams, reasoning, sources: detected.sources, providerLabel: options.providerLabel?.(registration.provider) ?? registration.provider })
    }
  }

  list() {
    return [...this.entries.values()].map(({ registration, model, sources, providerLabel, reasoning }) => ({
      provider: model.provider, providerLabel, model: model.id, label: model.name, input: model.input, reasoning: model.reasoning, sources,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      thinkingLevels: reasoning.levels, configured: !!this.key(registration.keyEnv),
      defaultThinkingLevel: reasoning.default, reasoningControl: reasoning,
      reasoningSource: sources.reasoning,
    }))
  }

  replace(registrations: ModelRegistration[], options = this.options) {
    const replacement = new ModelRegistry(registrations, options)
    this.entries = replacement.entries
  }

  registrations(): ModelRegistration[] {
    return [...this.entries.values()].map(({ registration, model }) => ({ ...structuredClone(registration),
      api: registration.api, baseUrl: registration.baseUrl ?? model.baseUrl,
    }))
  }

  resolve(route: ModelRoute, images: ImageContent[] = []) {
    const entry = this.entries.get(routeKey(route))
    requireValue(entry, 'MODEL_NOT_CONFIGURED', '这个模型尚未在服务端配置，请检查模型设置。')
    requireValue(this.key(entry.registration.keyEnv), 'MODEL_KEY_MISSING', '所选模型的 API 密钥尚未配置。')
    requireValue(images.length === 0 || entry.model.input.includes('image'), 'MODEL_VISION_REQUIRED', '所选模型不支持图片；请更换支持图片的模型或移除图片。')
    const reasoning = resolveReasoning(entry.reasoning, route.reasoningEffort)
    requireReasoningBudget(entry.reasoning.control, reasoning, this.outputBudget(route))
    const thinkingLevel = reasoning.effective === 'provider-default' || reasoning.effective === 'off' ? 'off' : reasoning.effective === 'enabled' ? 'medium' : reasoning.effective
    return { model: entry.model, thinkingLevel: thinkingLevel as ModelThinkingLevel, reasoning }
  }

  routes(profile: StoryProfile, defaults: { main: ModelRoute; writer?: ModelRoute | ModelSelection }) {
    const selected = profile.runtime.provider && profile.runtime.model
      ? { provider: profile.runtime.provider, model: profile.runtime.model } : defaults.main
    const main = { ...selected, ...(profile.runtime.reasoningEffort === undefined ? {} : { reasoningEffort: profile.runtime.reasoningEffort }) }
    const selection = profile.runtime.writerRoute ?? defaults.writer
    const writer = selection && 'kind' in selection ? resolveModelSelection(selection, main) : selection ?? main
    this.resolve(main); this.resolve(writer)
    return { main, writer }
  }

  /** Keep the route selection through Agent, whose off state becomes an omitted SDK option. */
  bindReasoning(route: ModelRoute, stream: StreamFn = this.stream.bind(this)): StreamFn {
    return (model, context, options) => stream(model, context, { ...options, reasoningSelection: route.reasoningEffort ?? 'model-default' } as ModelStreamOptions)
  }

  requestReasoning(model: Model<Api>, options: ModelStreamOptions = {}) {
    const entry = this.entries.get(routeKey({ provider: model.provider, model: model.id }))
    requireValue(entry, 'MODEL_NOT_CONFIGURED', '这个模型未配置。')
    return resolveReasoning(entry.reasoning, options.reasoningSelection ?? options.reasoning)
  }

  stream(model: Model<Api>, context: Context, options: ModelStreamOptions = {}) {
    const entry = this.entries.get(routeKey({ provider: model.provider, model: model.id }))
    requireValue(entry, 'MODEL_NOT_CONFIGURED', '这个模型未配置。')
    requireValue(context.messages.every(message => !Array.isArray(message.content) || message.content.every(part => part.type !== 'image' || model.input.includes('image'))),
      'MODEL_VISION_REQUIRED', '所选模型不支持当前图片附件。')
    const key = this.key(entry.registration.keyEnv)
    requireValue(key, 'MODEL_KEY_MISSING', '所选模型的 API 密钥尚未配置。')
    const { onQueued, onRequestParameters, reasoningSelection: _selection, onPayload, ...streamOptions } = options
    const reasoning = this.requestReasoning(model, options)
    requireValue(options.maxTokens === undefined || Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0, 'MODEL_OUTPUT_BUDGET_INVALID', '调用输出上限必须是正整数。')
    const outputCap = Math.min(options.maxTokens ?? Infinity, this.outputBudget({ provider: model.provider, model: model.id }))
    const request = prepareReasoningRequest(model, entry.reasoning.control, reasoning, outputCap)
    return this.requests.stream(model, signal => entry.streams.streamSimple(request.model, context, {
      timeoutMs: 120_000, maxRetries: 1, maxRetryDelayMs: 10_000,
      ...(entry.registration.temperature === undefined ? {} : { temperature: entry.registration.temperature }),
      ...streamOptions, ...request.options, signal, apiKey: key, ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      onPayload: async (payload, sentModel) => {
        const supplied = await onPayload?.(payload, sentModel)
        const final = applyReasoningPayload(supplied ?? payload, request.model, entry.reasoning.control, reasoning, outputCap)
        onRequestParameters?.(reasoningParameters(final))
        return final
      },
    }), options.signal, onQueued)
  }

  /** Optional answer allowance adds explicit thinking tokens, within the application hard cap. */
  outputBudget(route: ModelRoute, answerTokens?: number) {
    const entry = this.entries.get(routeKey(route))
    requireValue(entry, 'MODEL_NOT_CONFIGURED', '这个模型未配置。')
    const cap = Math.min(entry.registration.outputTokens ?? 8192, entry.model.maxTokens)
    if (answerTokens === undefined) return cap
    const reasoning = resolveReasoning(entry.reasoning, route.reasoningEffort)
    const total = Math.min(cap, answerTokens + thinkingBudget(entry.reasoning.control, reasoning))
    requireReasoningBudget(entry.reasoning.control, reasoning, total)
    return total
  }

  private key(name: string) { return (this.options.env ?? (key => process.env[key]))(name) }
}

function routeKey(route: ModelRoute) { return `${route.provider}\u0000${route.model}` }
