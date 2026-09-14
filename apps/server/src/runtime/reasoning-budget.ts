import type { ReasoningControlConfig, ReasoningLevel, ResolvedReasoning } from '../../../../packages/protocol/src/reasoning.ts'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'

export const MIN_ANSWER_TOKENS = 1024

export function thinkingBudget(control: ReasoningControlConfig, reasoning: ResolvedReasoning) {
  return control.mode === 'budget' ? control.levels[reasoning.effective as ReasoningLevel] ?? 0 : 0
}

export function requireReasoningBudget(control: ReasoningControlConfig, reasoning: ResolvedReasoning, maxTokens: number) {
  const budget = thinkingBudget(control, reasoning)
  requireValue(!budget || budget + MIN_ANSWER_TOKENS <= maxTokens, 'MODEL_REASONING_BUDGET_INVALID',
    `思考预算为 ${budget} tokens，需要为正文保留至少 ${MIN_ANSWER_TOKENS} tokens；请在高级设置中提高单次输出限制或降低思考预算。`)
}
