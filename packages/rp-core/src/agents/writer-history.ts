import { requireValue } from '../errors.ts'

export const WRITER_HISTORY_LIMITS = { rounds: 2, steps: 16, characters: 20_000, bytes: 262_144 } as const
export interface WriterHistoryStep { name: string; argumentsJson: string; resultJson: string; isError: boolean }
export interface WriterHistoryRound { user: string; steps: WriterHistoryStep[]; assistant: string }
export interface WriterHistoryConfig { enabled: boolean; rounds: WriterHistoryRound[] }
export interface WriterHistorySettings { version: 1; revision: number; config: WriterHistoryConfig }
export interface WriterHistoryMetadata { revision: number; digest: string; messageCount: number; toolCallCount: number }
type Text = { type: 'text'; text: string }
export type WriterHistoryMessage =
  | { role: 'user'; content: Text[] }
  | { role: 'assistant'; content: [Text] | [{ type: 'toolCall'; id: string; name: string; argumentsJson: string }] }
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: Text[]; isError: boolean }
export interface FrozenWriterHistory { metadata: WriterHistoryMetadata; messages: WriterHistoryMessage[] }

export const blankWriterHistoryStep = (): WriterHistoryStep => ({ name: '', argumentsJson: '{}', resultJson: '{}', isError: false })
export const blankWriterHistory = (): WriterHistoryConfig => ({ enabled: false,
  rounds: Array.from({ length: 2 }, () => ({ user: '', steps: [blankWriterHistoryStep()], assistant: '' })) })

function keys(value: unknown, names: string): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === names,
    'INVALID_WRITER_HISTORY', 'Writer 预置历史结构不正确。')
}

/** Keep JSON source strings intact: parsing and reserializing here would round large numbers. */
export function normalizeWriterHistory(input: unknown): WriterHistoryConfig {
  keys(input, 'enabled,rounds')
  requireValue(typeof input.enabled === 'boolean' && Array.isArray(input.rounds) && input.rounds.length === 2,
    'INVALID_WRITER_HISTORY', 'Writer 预置历史必须包含两轮。')
  for (const round of input.rounds) {
    keys(round, 'assistant,steps,user')
    requireValue(typeof round.user === 'string' && typeof round.assistant === 'string' && Array.isArray(round.steps) && round.steps.length <= WRITER_HISTORY_LIMITS.steps,
      'INVALID_WRITER_HISTORY', '每轮最多包含 16 个工具步骤。')
    for (const step of round.steps) {
      keys(step, 'argumentsJson,isError,name,resultJson')
      requireValue(typeof step.name === 'string' && typeof step.argumentsJson === 'string' && typeof step.resultJson === 'string' && typeof step.isError === 'boolean',
        'INVALID_WRITER_HISTORY', '工具步骤格式不正确。')
    }
  }
  requireValue(new TextEncoder().encode(JSON.stringify(input)).length <= WRITER_HISTORY_LIMITS.bytes,
    'WRITER_HISTORY_TOO_LARGE', 'Writer 预置历史配置不能超过 262,144 字节。')
  const config = structuredClone(input) as unknown as WriterHistoryConfig
  if (config.enabled) {
    const issues = writerHistoryIssues(config)
    requireValue(!issues.length, 'INVALID_WRITER_HISTORY', issues.join('\n'))
  }
  return config
}

export function writerHistoryIssues(config: WriterHistoryConfig): string[] {
  const issues: string[] = []
  config.rounds.forEach((round, r) => {
    const prefix = `第 ${r + 1} 轮`
    if (!round.user.trim()) issues.push(`${prefix}：用户消息不能为空。`)
    if (!round.assistant.trim()) issues.push(`${prefix}：助手最终回复不能为空。`)
    if (!round.steps.length || round.steps.length > 16) issues.push(`${prefix}：需要 1–16 个工具步骤。`)
    round.steps.forEach((step, s) => {
      const location = `${prefix}，步骤 ${s + 1}`
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(step.name)) issues.push(`${location}：工具名限 1–64 位英文字母、数字、下划线或连字符。`)
      for (const [label, source] of [['参数', step.argumentsJson], ['结果', step.resultJson]]) {
        try {
          const value: unknown = JSON.parse(source!)
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
        } catch { issues.push(`${location}：${label}必须是合法的对象型 JSON。`) }
      }
    })
  })
  if (!issues.length && writerHistoryPreview(compileWriterHistory(config)).length > WRITER_HISTORY_LIMITS.characters)
    issues.push('编译后的 Writer 预置历史不能超过 20,000 字符。')
  return issues
}

/** Pure history compilation; no tool registry or execution is involved. IDs are not editable. */
export function compileWriterHistory(config: WriterHistoryConfig): WriterHistoryMessage[] {
  return config.rounds.flatMap((round, r) => {
    const messages: WriterHistoryMessage[] = [{ role: 'user', content: [{ type: 'text', text: round.user }] }]
    round.steps.forEach((step, s) => {
      const id = `wh_r${r + 1}_s${s + 1}`
      messages.push({ role: 'assistant', content: [{ type: 'toolCall', id, name: step.name, argumentsJson: step.argumentsJson }] },
        { role: 'toolResult', toolCallId: id, toolName: step.name, content: [{ type: 'text', text: step.resultJson }], isError: step.isError })
    })
    messages.push({ role: 'assistant', content: [{ type: 'text', text: round.assistant }] })
    return messages
  })
}

/** Render native Pi message content without passing arbitrary-precision numbers through JS numbers. */
export function writerHistoryPreview(messages: WriterHistoryMessage[]): string {
  return `[\n${messages.map(message => {
    const block = message.content[0]
    if (message.role !== 'assistant' || block?.type !== 'toolCall') return JSON.stringify(message)
    return `{"role":"assistant","content":[{"type":"toolCall","id":${JSON.stringify(block.id)},"name":${JSON.stringify(block.name)},"arguments":${block.argumentsJson}}]}`
  }).join(',\n')}\n]`
}
