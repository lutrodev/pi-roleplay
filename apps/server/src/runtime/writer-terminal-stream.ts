import type { StreamFn } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai'
import type { WriterDeliverySession } from './writer-delivery.ts'

/** Provider diagnostics wrap the source, retaining raw calls; Agent receives decoded text. */
export function terminalDeliveryStream(source: StreamFn, delivery: WriterDeliverySession): StreamFn {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream()
    void (async () => {
      let partial: AssistantMessage | undefined
      let completed = false
      try {
        const response = await source(model, context, { ...options, toolChoice: 'auto' })
        for await (const event of response) {
          if (event.type === 'start') {
            partial = event.partial
            delivery.observe({ type: 'message_start', message: partial })
            output.push({ type: 'start', partial: { ...partial, content: [] } })
          } else if (event.type === 'done') {
            completed = true
            const message = delivery.unwrap(event.message)
            if (message.stopReason === 'error' || message.stopReason === 'aborted') output.push({ type: 'error', reason: message.stopReason, error: message })
            else output.push({ ...event, reason: message.stopReason === 'pending' ? event.reason : message.stopReason, message })
          } else if (event.type === 'error') {
            completed = true
            // Error/length/cancellation must never be upgraded to successful text delivery.
            delivery.unwrap(event.error)
            output.push(event)
          } else {
            partial = event.partial
            // Incremental JSON decoding feeds live drafts, not executable Agent tool calls.
            delivery.observe({ type: 'message_update', assistantMessageEvent: event, message: partial })
          }
        }
        if (!completed) throw new Error('终端交付流缺少结束事件。')
      } catch (error) {
        const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), content: [], usage: partial?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: error instanceof Error ? error.message : '终端交付响应失败。' }
        output.push({ type: 'error', reason: message.stopReason === 'aborted' ? 'aborted' : 'error', error: message })
      } finally { output.end() }
    })()
    return output
  }
}
