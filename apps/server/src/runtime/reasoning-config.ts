import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { reasoningLevels, type ReasoningControlConfig } from '../../../../packages/protocol/src/reasoning.ts'

export function validateReasoningControl(value: unknown): asserts value is ReasoningControlConfig {
  const valid = (condition: unknown, message: string) => requireValue(condition, 'MODEL_REASONING_CONFIG_INVALID', message)
  valid(value && typeof value === 'object' && !Array.isArray(value), '思考控制必须是对象。')
  const control = value as Record<string, unknown>
  valid(Object.keys(control).every(key => ['mode', 'format', 'levels', 'off'].includes(key)), '思考控制包含未知字段。')
  valid(['provider', 'toggle', 'effort', 'budget'].includes(String(control.mode)), '思考控制方式不正确。')
  if (control.mode === 'provider') { valid(Object.keys(control).length === 1, '服务默认不能附带思考参数。'); return }
  const formats = control.mode === 'budget' ? ['anthropic'] : control.mode === 'toggle' ? ['deepseek', 'qwen', 'zai', 'openrouter'] : ['openai', 'openai-responses', 'deepseek', 'qwen', 'zai', 'openrouter', 'anthropic']
  valid(formats.includes(String(control.format)), '思考控制与请求格式不匹配。')
  valid(control.off === undefined || (['openai', 'openai-responses'].includes(String(control.format))
    ? typeof control.off === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(control.off) : control.off === true), '关闭思考需要明确的关闭参数；OpenAI 格式需要填写服务接受的值。')
  if (control.mode === 'toggle') { valid(control.levels === undefined, '开关模式不能设置强度档位。'); return }
  valid(control.levels && typeof control.levels === 'object' && !Array.isArray(control.levels), '请设置模型实际支持的思考档位。')
  const entries = Object.entries(control.levels as Record<string, unknown>)
  valid(entries.length > 0 && entries.every(([key]) => reasoningLevels.includes(key as typeof reasoningLevels[number])), '至少启用一个有效的思考档位。')
  valid(entries.every(([, value]) => control.mode === 'budget' ? Number.isSafeInteger(value) && Number(value) >= 1024 && Number(value) <= 100_000_000 : typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)), '思考档位需要服务参数值，或至少 1024 tokens 的预算。')
  if (control.format === 'anthropic' && control.mode === 'effort') valid(entries.every(([, value]) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(value))), 'Anthropic 思考强度参数只能使用 low、medium、high、xhigh 或 max。')
  valid(new Set(entries.map(([, value]) => value)).size === entries.length, '多个档位不能发送相同的思考参数；请只保留有区别的档位。')
  valid(!entries.some(([, value]) => value === control.off), '开启和关闭不能使用相同的思考参数。')
}
