import { getSupportedThinkingLevels, type Api, type Context, type ImageContent, type Model, type ModelThinkingLevel, type ProviderStreams, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { ModelRoute, StoryProfile } from '../../../../packages/rp-core/src/types.ts'
import { resolveModelSelection, type ModelSelection } from '../../../../packages/rp-core/src/agents/catalog.ts'
import { defaultThinkingLevel } from './model-reasoning.ts'
import { resolveMetadata, type ModelIdentity, type ModelMetadata, type MetadataSources } from './model-metadata.ts'
import { ModelRequestQueue } from './model-request-queue.ts'

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
  outputTokens?: number
  temperature?: number
  compat?: Model<Api>['compat']
}

interface RegisteredModel { registration: ModelRegistration; model: Model<Api>; streams: ProviderStreams; sources: MetadataSources; providerLabel: string }

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
        compat: { ...(known?.compat && (!registration.api || registration.api === known.api) ? known.compat : {}), ...detected?.compat, ...registration.compat },
        ...(detected?.thinkingLevelMap ? { thinkingLevelMap: detected.thinkingLevelMap } : {}),
      }
      let url: URL | undefined
      try { url = new URL(model.baseUrl) } catch { /* validation below */ }
      requireValue(url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
        'MODEL_CONFIG_INVALID', '模型地址必须为 HTTP(S) 地址，不能携带凭据或查询参数。')
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
      this.entries.set(key, { registration: structuredClone(registration), model, streams, sources: detected.sources, providerLabel: options.providerLabel?.(registration.provider) ?? registration.provider })
    }
  }

  list() {
    return [...this.entries.values()].map(({ registration, model, sources, providerLabel }) => ({
      provider: model.provider, providerLabel, model: model.id, label: model.name, input: model.input, reasoning: model.reasoning, sources,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      thinkingLevels: getSupportedThinkingLevels(model), configured: !!this.key(registration.keyEnv),
      defaultThinkingLevel: defaultThinkingLevel(model),
      reasoningSource: sources.reasoning,
    }))
  }

  replace(registrations: ModelRegistration[], options = this.options) {
    const replacement = new ModelRegistry(registrations, options)
    this.entries = replacement.entries
  }

  registrations(): ModelRegistration[] {
    return [...this.entries.values()].map(({ registration, model }) => ({ ...structuredClone(registration),
      api: registration.api, baseUrl: model.baseUrl,
    }))
  }

  resolve(route: ModelRoute, images: ImageContent[] = []) {
    const entry = this.entries.get(routeKey(route))
    requireValue(entry, 'MODEL_NOT_CONFIGURED', '这个模型尚未在服务端配置，请检查模型设置。')
    requireValue(this.key(entry.registration.keyEnv), 'MODEL_KEY_MISSING', '所选模型的 API 密钥尚未配置。')
    requireValue(images.length === 0 || entry.model.input.includes('image'), 'MODEL_VISION_REQUIRED', '所选模型不支持图片；请更换支持图片的模型或移除图片。')
    const thinkingLevel = route.reasoningEffort ?? defaultThinkingLevel(entry.model)
    requireValue(getSupportedThinkingLevels(entry.model).includes(thinkingLevel as ModelThinkingLevel), 'MODEL_REASONING_UNSUPPORTED', '所选模型不支持这个思考强度。')
    return { model: entry.model, thinkingLevel: thinkingLevel as ModelThinkingLevel }
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

  stream(model: Model<Api>, context: Context, options: SimpleStreamOptions & { onQueued?: (queued: boolean) => void } = {}) {
    const entry = this.entries.get(routeKey({ provider: model.provider, model: model.id }))
    requireValue(entry, 'MODEL_NOT_CONFIGURED', '这个模型未配置。')
    requireValue(context.messages.every(message => !Array.isArray(message.content) || message.content.every(part => part.type !== 'image' || model.input.includes('image'))),
      'MODEL_VISION_REQUIRED', '所选模型不支持当前图片附件。')
    const key = this.key(entry.registration.keyEnv)
    requireValue(key, 'MODEL_KEY_MISSING', '所选模型的 API 密钥尚未配置。')
    const { onQueued, ...streamOptions } = options
    return this.requests.stream(model, signal => entry.streams.streamSimple(model, context, {
      timeoutMs: 120_000, maxRetries: 1, maxRetryDelayMs: 10_000,
      maxTokens: entry.registration.outputTokens ?? Math.min(8192, model.maxTokens),
      ...(entry.registration.temperature === undefined ? {} : { temperature: entry.registration.temperature }),
      ...streamOptions, signal, apiKey: key, ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    }), options.signal, onQueued)
  }

  outputBudget(route: ModelRoute) {
    const entry = this.entries.get(routeKey(route))
    requireValue(entry, 'MODEL_NOT_CONFIGURED', '这个模型未配置。')
    return entry.registration.outputTokens ?? Math.min(8192, entry.model.maxTokens)
  }

  private key(name: string) { return (this.options.env ?? (key => process.env[key]))(name) }
}

function routeKey(route: ModelRoute) { return `${route.provider}\u0000${route.model}` }
