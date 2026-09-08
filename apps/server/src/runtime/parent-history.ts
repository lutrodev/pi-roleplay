import type { Api, Message, Model } from '@earendil-works/pi-ai'
import type { JsonObject, JsonValue } from '../../../../packages/rp-core/src/types.ts'
import type { ModelHistoryEntry } from '../../../../packages/rp-core/src/story/model-history.ts'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { FileRepository } from '../storage/file-repository.ts'
import { createHash } from 'node:crypto'

export type ParentMessage = Message & { rpHistoryId: string; rpSource: ModelHistoryEntry['kind']; rpRunId: string | null }

/** File references stay durable; native image bytes are restored only at the Pi boundary. */
export function parentMessages(entries: ModelHistoryEntry[], files: FileRepository, model: Model<Api>) {
  const restored = entries.map(entry => {
    const message = restore(entry.message, files) as JsonObject
    if (message.role === 'assistant') {
      // Openings and user-authored imports have no provider response/usage to preserve.
      message.api ??= model.api; message.provider ??= model.provider; message.model ??= model.id
      message.stopReason ??= 'stop'
      message.usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    }
    const scope = (id: string) => {
      if (!entry.runId) return id
      const [call, ...responseItem] = id.split('|')
      const scoped = `${entry.runId}_m_${createHash('sha256').update(`${entry.ownerMessageId}:${call}`).digest('hex').slice(0, 20)}`
      // Pi's Responses adapter stores the response item ID after '|'; keep that provider replay metadata.
      return responseItem.length ? `${scoped}|${responseItem.join('|')}` : scoped
    }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') message.toolCallId = scope(message.toolCallId)
    if (Array.isArray(message.content)) message.content = message.content.map(part => {
      if (part && typeof part === 'object' && !Array.isArray(part) && part.type === 'toolCall' && typeof part.id === 'string') return { ...part, id: scope(part.id) }
      return part
    })
    return { ...message, rpHistoryId: entry.id, rpSource: entry.kind, rpRunId: entry.runId } as unknown as ParentMessage
  })
  const results = new Set(restored.flatMap(message => message.role === 'toolResult' ? [message.toolCallId] : []))
  const calls = new Set<string>(), omitted: { id: string; tool: string }[] = []
  const paired = restored.flatMap<ParentMessage>(message => {
    if (message.role !== 'assistant') return [message]
    const content = message.content.filter(part => {
      if (part.type !== 'toolCall') return true
      if (results.has(part.id)) { calls.add(part.id); return true }
      // A crash can leave an unfinished call. Never invent a successful result or re-execute it.
      omitted.push({ id: part.id, tool: part.name }); return false
    })
    return content.length ? [{ ...message, content }] : []
  }).filter(message => message.role !== 'toolResult' || calls.has(message.toolCallId))
  const messages: ParentMessage[] = [], deferred: ParentMessage[] = [], pending = new Set<string>()
  for (const message of paired) {
    if (message.role === 'user' && pending.size) { deferred.push(message); continue }
    messages.push(message)
    if (message.role === 'assistant') for (const part of message.content) if (part.type === 'toolCall') pending.add(part.id)
    if (message.role === 'toolResult') pending.delete(message.toolCallId)
    if (!pending.size) messages.push(...deferred.splice(0))
  }
  messages.push(...deferred)
  return { messages, omitted }
}

function restore(value: JsonValue, files: FileRepository): JsonValue {
  if (Array.isArray(value)) return value.map(part => restore(part, files))
  if (!value || typeof value !== 'object') return value
  if (value.type === 'image_reference' || value.type === 'attachment_reference') {
    requireValue(typeof value.fileId === 'string', 'MODEL_HISTORY_INVALID', '历史附件缺少文件标识。', 500)
    const { file, bytes } = files.read(value.fileId)
    if (file.mimeType.startsWith('image/')) return { type: 'image', data: bytes.toString('base64'), mimeType: file.mimeType }
    return { type: 'text', text: '<attachment format="json">' + JSON.stringify({ id: file.id, name: file.name, mimeType: file.mimeType, path: `/inputs/${file.storageKey}` }) + '</attachment>' }
  }
  return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, restore(part, files)]))
}
