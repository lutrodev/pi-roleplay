import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai'
import { controlLevels, type ReasoningControlConfig, type ReasoningDescriptor, type ReasoningLevel, type ResolvedReasoning } from '../../../../packages/protocol/src/reasoning.ts'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { ModelRegistration } from './models.ts'
import { catalogCandidates, catalogReasoning } from './model-reasoning.ts'
import type { ModelMetadata } from './model-metadata.ts'
import { validateReasoningControl } from './reasoning-config.ts'
import { sameModelEndpoint } from './model-endpoint.ts'
import { MIN_ANSWER_TOKENS } from './reasoning-budget.ts'

const endpoint = (url?: string) => url?.replace(/\/+$/, '').replace(/\/v1$/, '')

/** Never copy a native vendor's request dialect to an unidentified proxy. */
function automaticControl(registration: ModelRegistration, model: Model<Api>, remote?: ModelMetadata): ReasoningControlConfig | undefined {
  // Built-in Pi providers may use protocols outside the three configurable connection APIs.
  // Keep their default calls available without assigning them an OpenAI request dialect.
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(model.api)) return undefined
  if (remote?.reasoningControl) return remote.reasoningControl
  if (!model.reasoning) return undefined
  const candidates = catalogCandidates(registration)
  const trusted = candidates.some(candidate => sameModelEndpoint(candidate, model))
    || !candidates.length && !!catalogReasoning(registration) && endpoint(model.baseUrl) === 'https://api.openai.com'
  const explicitFormat = (registration.compat as { thinkingFormat?: string; supportsReasoningEffort?: boolean } | undefined)?.thinkingFormat
  const compat = model.compat as { thinkingFormat?: string; supportsReasoningEffort?: boolean; forceAdaptiveThinking?: boolean }
  // An exact model's effort map is more specific than a connection-wide toggle hint.
  // Explicit reasoningControl remains the authoritative way to override model controls.
  const declaredCompat = remote?.compat ?? (trusted ? catalogReasoning(registration)?.compat : undefined)
  const declaredEffort = !!model.thinkingLevelMap && (declaredCompat as Model<'openai-completions'>['compat'])?.supportsReasoningEffort === true
  const toggleOnly = compat.supportsReasoningEffort === false && !declaredEffort
  if (explicitFormat && toggleOnly && ['qwen', 'zai', 'deepseek', 'openrouter'].includes(explicitFormat)) {
    return { mode: 'toggle', format: explicitFormat as 'qwen', ...(model.thinkingLevelMap?.off !== null ? { off: true } : {}) }
  }
  if (!trusted && !remote?.thinkingLevelMap) return undefined
  const format = model.api === 'anthropic-messages' ? 'anthropic' : model.api === 'openai-responses' ? 'openai-responses'
    : explicitFormat ?? (new URL(model.baseUrl).hostname === 'openrouter.ai' ? 'openrouter' : compat.thinkingFormat ?? 'openai')
  if (!['openai', 'openai-responses', 'deepseek', 'qwen', 'zai', 'openrouter', 'anthropic'].includes(format)) return undefined
  if (toggleOnly && ['qwen', 'zai', 'deepseek', 'openrouter'].includes(format)) return { mode: 'toggle', format: format as 'qwen', ...(model.thinkingLevelMap?.off !== null ? { off: true } : {}) }
  if (compat.supportsReasoningEffort === false && format === 'openai') return undefined
  if (format === 'anthropic' && !compat.forceAdaptiveThinking) {
    const levels = Object.fromEntries(Object.entries({ minimal: 1024, low: 2048, medium: 8192, high: 16384 }).filter(([, budget]) => budget + MIN_ANSWER_TOKENS <= model.maxTokens))
    if (!Object.keys(levels).length) return undefined
    return { mode: 'budget', format, levels, ...(model.thinkingLevelMap?.off !== null ? { off: true } : {}) }
  }
  const levels: Partial<Record<ReasoningLevel, string>> = {}, used = new Set<string>()
  for (const level of getSupportedThinkingLevels(model)) {
    if (level === 'off') continue
    // Pi maps Anthropic's minimal to low; expose each wire value only once.
    if (format === 'anthropic' && level === 'minimal') continue
    const mapped = model.thinkingLevelMap?.[level] ?? level
    if (typeof mapped === 'string' && !used.has(mapped)) { levels[level] = mapped; used.add(mapped) }
  }
  if (!Object.keys(levels).length) return undefined
  const off = ['openai', 'openai-responses'].includes(format) ? typeof model.thinkingLevelMap?.off === 'string' ? model.thinkingLevelMap.off : undefined
    : model.thinkingLevelMap?.off === null ? undefined : true
  return { mode: 'effort', format: format as 'openai', levels, ...(off === undefined ? {} : { off }) }
}

export function describeReasoning(registration: ModelRegistration, model: Model<Api>, remote?: ModelMetadata): ReasoningDescriptor {
  if (registration.reasoningControl !== undefined) validateReasoningControl(registration.reasoningControl)
  const control = registration.reasoningControl ?? automaticControl(registration, model, remote) ?? { mode: 'provider' }
  requireValue(control.mode === 'provider' || model.reasoning, 'MODEL_REASONING_CONFIG_INVALID', '请先将思考能力设为支持，再配置思考控制。')
  if (control.mode !== 'provider') {
    const api = control.format === 'anthropic' ? 'anthropic-messages' : control.format === 'openai-responses' ? 'openai-responses' : 'openai-completions'
    requireValue(api === model.api, 'MODEL_REASONING_CONFIG_INVALID', '思考参数格式与模型的 API 协议不一致。')
    if (control.mode === 'budget') requireValue(Object.values(control.levels).every(budget => budget! + MIN_ANSWER_TOKENS <= model.maxTokens), 'MODEL_REASONING_CONFIG_INVALID', '思考预算加上正文预留不能超过模型最大输出。')
  }
  const levels = controlLevels(control)
  const defaultLevel = registration.defaultReasoningEffort ?? 'provider-default'
  requireValue(levels.includes(defaultLevel), 'MODEL_REASONING_UNSUPPORTED', '模型默认思考强度不可用，请选择服务默认或已支持的档位。')
  return { control, levels, default: defaultLevel, source: registration.reasoningControl ? 'manual' : control.mode === 'provider' ? 'unknown' : remote?.reasoningControl || remote?.thinkingLevelMap ? 'provider' : registration.compat ? 'manual' : 'catalog' }
}

export function resolveReasoning(descriptor: ReasoningDescriptor, selected?: string): ResolvedReasoning {
  const effective = selected === undefined || selected === 'model-default' ? descriptor.default : selected
  requireValue(descriptor.levels.includes(effective), 'MODEL_REASONING_UNSUPPORTED', '所选模型或渠道不支持这个思考强度，请检查模型的思考控制设置。')
  return { requested: selected ?? 'model-default', effective, source: selected && selected !== 'model-default' ? 'selection' : descriptor.default === 'provider-default' ? 'provider-default' : 'model-default', controlSource: descriptor.source, mode: descriptor.control.mode }
}
