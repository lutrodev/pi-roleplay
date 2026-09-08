import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'

export const PRUNE_MARKER = '\n\n[工具结果中段已省略；完整结果保存在工具记录。文件可按行范围继续读取。]\n\n'
const threshold = 8192, head = 4096, tail = 1024
const PRUNABLE = new Set(['bash', 'str_replace_editor', 'read', 'web_search'])
export interface PruneRecord { version: 1; toolCallId: string; toolName: string; beforeCharacters: number; afterCharacters: number; headCharacters: number; tailCharacters: number }

/** Transform only model input. The original tool result, pairing, image positions and authoritative RP results survive. */
export function pruneToolMessages(messages: AgentMessage[], record?: (value: PruneRecord) => void): AgentMessage[] {
  return messages.map(message => {
    if (message.role !== 'toolResult' || !PRUNABLE.has(message.toolName)) return message
    const before = message.content.reduce((sum, part) => sum + (part.type === 'text' ? [...part.text].length : 0), 0)
    if (before <= threshold) return message
    const content: (TextContent | ImageContent)[] = []
    let consumed = 0, inserted = false
    for (const part of message.content) {
      if (part.type !== 'text') { content.push(part); continue }
      const points = [...part.text], start = consumed, end = start + points.length
      const first = Math.min(points.length, Math.max(0, head - start)), last = Math.min(points.length, Math.max(0, before - tail - start))
      const marker = start < before - tail && end > head && !inserted ? PRUNE_MARKER : ''
      if (marker) inserted = true
      const text = points.slice(0, first).join('') + marker + points.slice(last).join('')
      if (text) content.push({ ...part, text })
      consumed = end
    }
    record?.({ version: 1, toolCallId: message.toolCallId, toolName: message.toolName, beforeCharacters: before,
      afterCharacters: content.reduce((sum, part) => sum + (part.type === 'text' ? [...part.text].length : 0), 0), headCharacters: head, tailCharacters: tail })
    return { ...message, content }
  })
}

export function contextPruner(record: (value: PruneRecord) => void) {
  const recorded = new Set<string>()
  return async (messages: AgentMessage[]) => pruneToolMessages(messages, value => {
    const key = `${value.toolCallId}:${value.beforeCharacters}`
    if (recorded.has(key)) return
    record(value); recorded.add(key)
  })
}
