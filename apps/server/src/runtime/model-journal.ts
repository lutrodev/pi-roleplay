import { randomUUID } from 'node:crypto'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai'
import type { RunJournal } from './journal.ts'
import type { ModelRegistry } from './models.ts'
import type { WriterHistoryMetadata } from '../../../../packages/rp-core/src/agents/writer-history.ts'
import { beginModelProgress } from './live-progress.ts'

/** Record the exact Pi boundary after context pruning, including every retry/continuation and recipient. */
export function journalStream(journal: RunJournal, models: ModelRegistry, scope: string, parentCallId?: string, writerHistory?: WriterHistoryMetadata): StreamFn {
  return (model, context, options) => {
    const requestId = randomUUID(), owner = parentCallId ?? journal.callId(requestId), started = performance.now()
    journal.model(owner, 'provider:request', { requestId, scope, parentCallId, provider: model.provider, model: model.id, api: model.api,
      baseUrl: model.baseUrl, contextWindow: model.contextWindow, outputBudget: models.outputBudget({ provider: model.provider, model: model.id }),
      systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools ?? [], reasoning: options?.reasoning ?? 'off',
      ...(writerHistory ? { writerHistory, historyMessagesJson: context.messages.slice(0, writerHistory.messageCount).map(message => JSON.stringify(message)) } : {}),
    })
    const output = createAssistantMessageEventStream()
    const progress = beginModelProgress(journal.stories, journal.run.id, requestId)
    void (async () => {
      let firstTokenMs: number | undefined, complete = false
      const record = (response: AssistantMessage) => journal.model(owner, 'provider:response', {
        requestId, scope, parentCallId, elapsedMs: Math.round(performance.now() - started), firstTokenMs, response,
      })
      try {
        const source = models.stream(model, context, { ...options, onQueued: value => progress.queued(value) })
        for await (const event of source) {
          progress.update(event)
          if (firstTokenMs === undefined && event.type.endsWith('_delta')) firstTokenMs = Math.round(performance.now() - started)
          if (event.type === 'done' || event.type === 'error') { record(event.type === 'done' ? event.message : event.error); complete = true; progress.close() }
          output.push(event)
        }
        if (!complete) throw new Error('Model stream ended without a terminal event')
      } catch {
        const error: AssistantMessage = { role: 'assistant', provider: model.provider, model: model.id, api: model.api, content: [], timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: '模型调用或运行记录保存失败。' }
        try { record(error) } catch { /* The failed stream still terminates; no success is reported without a durable record. */ }
        progress.close()
        output.push({ type: 'error', reason: error.stopReason === 'aborted' ? 'aborted' : 'error', error })
      } finally { progress.close(); output.end() }
    })()
    return output
  }
}
