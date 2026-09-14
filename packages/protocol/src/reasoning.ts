/** Capability and request controls are separate: supporting reasoning does not imply an effort API. */
export const reasoningLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningLevel = typeof reasoningLevels[number]
export type ReasoningFormat = 'openai' | 'openai-responses' | 'deepseek' | 'qwen' | 'zai' | 'openrouter' | 'anthropic'
export type ReasoningControlConfig =
  | { mode: 'provider' }
  | { mode: 'toggle'; format: 'deepseek' | 'qwen' | 'zai' | 'openrouter'; off?: true }
  | { mode: 'effort'; format: ReasoningFormat; levels: Partial<Record<ReasoningLevel, string>>; off?: string | true }
  | { mode: 'budget'; format: 'anthropic'; levels: Partial<Record<ReasoningLevel, number>>; off?: true }
export type ReasoningSource = 'provider' | 'catalog' | 'manual' | 'unknown'
export interface ReasoningDescriptor {
  control: ReasoningControlConfig
  source: ReasoningSource
  levels: string[]
  default: string
}
export interface ResolvedReasoning {
  requested: string
  effective: string
  source: 'selection' | 'model-default' | 'provider-default'
  controlSource: ReasoningSource
  mode: ReasoningControlConfig['mode']
}

export function controlLevels(control: ReasoningControlConfig): string[] {
  return ['provider-default', ...(control.mode !== 'provider' && control.off ? ['off'] : []), ...(control.mode === 'toggle' ? ['enabled'] : control.mode === 'provider' ? [] : reasoningLevels.filter(level => control.levels[level] !== undefined))]
}
