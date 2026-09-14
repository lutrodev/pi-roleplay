import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { reasoningLevels, type ReasoningControlConfig, type ResolvedReasoning } from '../../../../packages/protocol/src/reasoning.ts'
import { requireReasoningBudget, thinkingBudget } from './reasoning-budget.ts'

/** Give Pi the same mapping used at the wire boundary, including its replay metadata. */
export function prepareReasoningRequest(model: Model<Api>, control: ReasoningControlConfig, reasoning: ResolvedReasoning, outputCap: number) {
  requireReasoningBudget(control, reasoning, outputCap)
  const enabled = !['off', 'provider-default'].includes(reasoning.effective) && control.mode !== 'provider'
  let reasoningLevel = enabled ? reasoning.effective === 'enabled' ? 'medium' : reasoning.effective as SimpleStreamOptions['reasoning'] : undefined
  const prepared = { ...model }
  if (control.mode === 'effort') {
    prepared.thinkingLevelMap = { off: typeof control.off === 'string' ? control.off : control.off ? 'off' : null,
      ...Object.fromEntries(reasoningLevels.map(level => [level, control.levels[level] ?? null])) }
  }
  if (model.api === 'anthropic-messages') {
    const compat = model.compat as Model<'anthropic-messages'>['compat']
    prepared.compat = { ...model.compat,
      ...(control.mode === 'effort' ? { forceAdaptiveThinking: true } : control.mode === 'budget' ? { forceAdaptiveThinking: false } : {}),
      // An omitted preference must not become Pi's hard-coded current high effort.
      supportsMidConvoEffort: enabled && control.mode === 'effort' && compat?.supportsMidConvoEffort === true,
    }
  }
  const budget = thinkingBudget(control, reasoning)
  // Pi adds a budget to maxTokens. Pass only the answer allowance so the total stays bounded.
  if (budget) reasoningLevel = 'high'
  return { model: prepared, options: { reasoning: reasoningLevel, maxTokens: outputCap - budget,
    ...(budget ? { thinkingBudgets: { high: budget } } : {}) } satisfies SimpleStreamOptions }
}
