import type { Api, Model } from '@earendil-works/pi-ai'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { ReasoningControlConfig, ReasoningLevel, ResolvedReasoning } from '../../../../packages/protocol/src/reasoning.ts'
import { requireReasoningBudget } from './reasoning-budget.ts'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Own reasoning controls at the final SDK boundary. Omission never means explicit off. */
export function applyReasoningPayload(payload: unknown, model: Model<Api>, control: ReasoningControlConfig, reasoning: ResolvedReasoning, outputCap: number) {
  const params = { ...object(payload) }
  const sdkThinking = object(params.thinking), sdkOutput = object(params.output_config)
  const { effort: _effort, ...responseOptions } = object(params.reasoning)
  for (const key of ['reasoning_effort', 'reasoning', 'thinking', 'enable_thinking', 'thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens']) delete params[key]
  if (model.api === 'google-generative-ai' || model.api === 'google-vertex') {
    const { thinkingConfig: _thinking, ...rest } = object(params.config)
    params.config = rest
  }
  if (model.api === 'bedrock-converse-stream' && params.additionalModelRequestFields) {
    const { thinking: _thinking, reasoning_config: _config, reasoning_effort: _effort, ...rest } = object(params.additionalModelRequestFields)
    if (Object.keys(rest).length) params.additionalModelRequestFields = rest
    else delete params.additionalModelRequestFields
  }
  if (params.output_config) {
    const { effort: _effort, ...rest } = object(params.output_config)
    if (Object.keys(rest).length) params.output_config = rest
    else delete params.output_config
  }
  for (const key of ['chat_template_kwargs', 'chat_template_args']) {
    if (!params[key]) continue
    const { enable_thinking: _enable, thinking: _thinking, ...rest } = object(params[key])
    if (Object.keys(rest).length) params[key] = rest
    else delete params[key]
  }
  const budgetField = (model.compat as { thinkingTokenBudgetField?: string } | undefined)?.thinkingTokenBudgetField
  if (budgetField) delete params[budgetField]
  // Pi may expand the answer cap to make room for budget-based thinking. Our output cap includes both.
  for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) if (typeof params[key] === 'number') params[key] = Math.min(params[key], outputCap)
  const providerDefault = reasoning.effective === 'provider-default' || control.mode === 'provider'
  const enabled = reasoning.effective !== 'off'
  if (model.api === 'openai-responses') {
    // Summary presentation is independent of effort. Keep requesting it when effort is omitted.
    if (model.reasoning && enabled) responseOptions.summary ??= 'auto'
    if (Object.keys(responseOptions).length) params.reasoning = responseOptions
  }
  if (model.api === 'anthropic-messages' && (providerDefault || !enabled || control.mode !== 'effort')) removeMessageEfforts(params)
  if (providerDefault) return params
  const value = control.mode === 'effort' || control.mode === 'budget' ? control.levels[reasoning.effective as ReasoningLevel] : undefined
  if (control.format === 'openai') params.reasoning_effort = enabled ? value : control.off
  else if (control.format === 'openai-responses') params.reasoning = { ...responseOptions, effort: enabled ? value : control.off }
  else if (control.format === 'openrouter') params.reasoning = control.mode === 'toggle' ? { enabled } : { effort: enabled ? value : 'none' }
  else if (control.format === 'anthropic') {
    if (!enabled) params.thinking = { type: 'disabled' }
    else if (control.mode === 'budget') {
      requireValue(typeof params.max_tokens === 'number', 'MODEL_REASONING_BUDGET_INVALID', '思考预算需要明确的输出上限。')
      requireReasoningBudget(control, reasoning, params.max_tokens)
      params.thinking = { ...sdkThinking, type: 'enabled', budget_tokens: value }
    } else {
      params.thinking = { ...sdkThinking, type: 'adaptive' }
      if ((model.compat as Model<'anthropic-messages'>['compat'])?.supportsMidConvoEffort === true) {
        // Keep the SDK's stable cache baseline and historical effort markers. Only the final marker controls this call.
        params.output_config = sdkOutput
        const messages = Array.isArray(params.messages) ? [...params.messages] : []
        const last = object(messages.at(-1))
        const marker = { role: 'system', content: [], output_config: { effort: value } }
        if (last.role === 'system' && Array.isArray(last.content) && last.content.length === 0 && object(last.output_config).effort !== undefined) messages[messages.length - 1] = { ...last, output_config: { ...object(last.output_config), effort: value } }
        else messages.push(marker)
        params.messages = messages
      } else params.output_config = { ...object(params.output_config), effort: value }
    }
    if (enabled) delete params.temperature
  } else {
    if (control.format === 'qwen') params.enable_thinking = enabled
    else params.thinking = { type: enabled ? 'enabled' : 'disabled', ...(control.format === 'zai' && enabled ? { clear_thinking: false } : {}) }
    if (enabled && control.mode === 'effort') params.reasoning_effort = value
  }
  return params
}

/** Safe request evidence: no credentials, headers, prompts, or reasoning text. */
export function reasoningParameters(payload: Record<string, unknown>) {
  const result = Object.fromEntries(['reasoning_effort', 'reasoning', 'thinking', 'enable_thinking', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature'].filter(key => payload[key] !== undefined).map(key => [key, payload[key]]))
  if (object(payload.output_config).effort !== undefined) result.output_config = { effort: object(payload.output_config).effort }
  if (Array.isArray(payload.messages)) {
    const controls = payload.messages.flatMap((message, index) => {
      const effort = object(object(message).output_config).effort
      return effort === undefined ? [] : [{ index, output_config: { effort } }]
    })
    if (controls.length) result.messages = controls
  }
  return result
}

function removeMessageEfforts(params: Record<string, unknown>) {
  if (!Array.isArray(params.messages)) return
  params.messages = params.messages.flatMap(value => {
    const message = object(value)
    if (object(message.output_config).effort === undefined) return [value]
    const { output_config: _output, ...rest } = message
    const { effort: _effort, ...output } = object(message.output_config)
    if (Object.keys(output).length) return [{ ...rest, output_config: output }]
    if (rest.role === 'system' && Array.isArray(rest.content) && rest.content.length === 0 && Object.keys(rest).every(key => key === 'role' || key === 'content')) return []
    return [rest]
  })
}
