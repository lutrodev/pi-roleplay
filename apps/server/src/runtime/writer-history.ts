import type { Api, Message, Model } from '@earendil-works/pi-ai'
import type { FrozenWriterHistory } from '../../../../packages/rp-core/src/agents/writer-history.ts'

import { losslessObject } from './lossless-json.ts'

/** Only constructs historical messages. Does not grant, resolve, or execute any historical tool. */
export function nativeWriterHistory(history: FrozenWriterHistory | undefined, model: Model<Api>): Message[] {
  if (!history) return []
  return history.messages.map(message => {
    if (message.role !== 'assistant') return { ...structuredClone(message), timestamp: 0 }
    const block = message.content[0]
    return { role: 'assistant', timestamp: 0, api: model.api, provider: model.provider, model: model.id,
      stopReason: block.type === 'toolCall' ? 'toolUse' : 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: block.type === 'toolCall' ? [{ type: 'toolCall', id: block.id, name: block.name, arguments: losslessObject(block.argumentsJson) }] : [{ ...block }],
    }
  })
}
