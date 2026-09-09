import type { ModelMetadata } from '../runtime/model-metadata.ts'
import type { ModelConnection } from './model-inspection.ts'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const tokens = (value: unknown, min = 1) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 100_000_000 ? value : undefined
const bool = (value: unknown) => typeof value === 'boolean' ? value : undefined

/** Explicit API fields only; model names, descriptions, pricing and substrings are not capability evidence.
 * OpenRouter: https://openrouter.ai/docs/guides/overview/models
 * Anthropic: https://platform.claude.com/docs/en/api/models
 * Cline: https://docs.cline.bot/api/models
 */
export function discoveryMetadata(value: Record<string, unknown>, connection: ModelConnection): ModelMetadata {
  const metadata: ModelMetadata = {}, architecture = record(value.architecture), capabilities = record(value.capabilities)
  const name = value.display_name ?? value.name
  if (typeof name === 'string' && name.trim()) metadata.label = name.trim().slice(0, 200)
  const modalities = architecture.input_modalities
  const vision = bool(record(capabilities.image_input).supported) ?? bool(value.supportsImages)
  if (Array.isArray(modalities) && modalities.length && modalities.every(item => typeof item === 'string') && modalities.includes('text')) metadata.input = modalities.includes('image') ? ['text', 'image'] : ['text']
  else if (vision !== undefined) metadata.input = vision ? ['text', 'image'] : ['text']
  const thinking = record(capabilities.thinking), parameters = value.supported_parameters
  const reasoning = bool(thinking.supported) ?? bool(value.supportsReasoning)
  if (reasoning !== undefined) metadata.reasoning = reasoning
  else if (Array.isArray(parameters) && parameters.every(item => typeof item === 'string')) metadata.reasoning = parameters.includes('reasoning') || parameters.includes('reasoning_effort')
  const context = tokens(value.context_length ?? value.max_input_tokens ?? value.contextWindow, 1024)
  const max = tokens(record(value.top_provider).max_completion_tokens ?? value.max_tokens ?? value.maxTokens)
  if (context !== undefined) metadata.contextWindow = context
  if (max !== undefined && (context === undefined || max <= context)) metadata.maxTokens = max
  if (connection.api === 'anthropic-messages' && bool(record(record(thinking.types).adaptive).supported) === true) {
    metadata.compat = { forceAdaptiveThinking: true }
    const effort = record(capabilities.effort)
    if (effort.supported === true) {
      metadata.thinkingLevelMap = Object.fromEntries(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => [level,
        level === 'off' ? 'off' : bool(record(effort[level]).supported) === true ? level : null]))
    }
  }
  return metadata
}
