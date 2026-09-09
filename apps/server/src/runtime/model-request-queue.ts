import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model } from '@earendil-works/pi-ai'
import { DEFAULT_CONCURRENCY, type ConcurrencySettings } from '../../../../packages/rp-core/src/settings/concurrency.ts'
import { RpError } from '../../../../packages/rp-core/src/errors.ts'

interface Waiting { provider: string; signal: AbortSignal; start: () => void; cancel: () => void }
/** Limits cover complete streams, including retries. A saturated connection never holds a global slot. */
export class ModelRequestQueue {
  private readonly waiting: Waiting[] = []
  private readonly active = new Map<string, number>()
  private readonly stop = new AbortController()
  constructor(readonly limits: () => ConcurrencySettings = () => DEFAULT_CONCURRENCY) {}
  status() { return { active: [...this.active.values()].reduce((sum, count) => sum + count, 0), queued: this.waiting.length } }
  wake() {
    if (this.stop.signal.aborted || !this.waiting.length) return
    const limits = this.limits()
    for (let index = 0; index < this.waiting.length && this.status().active < limits.maxRequests;) {
      const item = this.waiting[index]!
      if ((this.active.get(item.provider) ?? 0) >= limits.maxRequestsPerConnection) { index++; continue }
      this.waiting.splice(index, 1); item.start()
    }
  }
  close() { this.stop.abort(new RpError('PROCESS_INTERRUPTED', '服务停止中断了模型请求。')) }
  stream(model: Model<Api>, start: (signal: AbortSignal) => AssistantMessageEventStream, signal?: AbortSignal, onQueued?: (queued: boolean) => void) {
    const combined = signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal
    const output = createAssistantMessageEventStream()
    void (async () => {
      let release: (() => void) | undefined
      try {
        release = await this.acquire(model.provider, combined, onQueued)
        combined.throwIfAborted()
        let complete = false
        for await (const event of start(combined)) {
          if (event.type === 'done' || event.type === 'error') complete = true
          output.push(event)
        }
        if (!complete) throw new Error('模型响应中断，未收到完整结果。')
      } catch (cause) {
        const error: AssistantMessage = { role: 'assistant', provider: model.provider, model: model.id, api: model.api, content: [], timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: combined.aborted ? 'aborted' : 'error', errorMessage: combined.aborted ? '模型请求已停止。' : cause instanceof Error ? cause.message : '模型请求失败。' }
        output.push({ type: 'error', reason: error.stopReason === 'aborted' ? 'aborted' : 'error', error })
      } finally { release?.(); output.end() }
    })()
    return output
  }
  private acquire(provider: string, signal: AbortSignal, onQueued?: (queued: boolean) => void) {
    return new Promise<() => void>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      const item: Waiting = { provider, signal,
        start: () => {
          signal.removeEventListener('abort', item.cancel)
          this.active.set(provider, (this.active.get(provider) ?? 0) + 1)
          onQueued?.(false)
          let released = false
          resolve(() => {
            if (released) return
            released = true
            const count = this.active.get(provider)! - 1
            if (count) this.active.set(provider, count); else this.active.delete(provider)
            this.wake()
          })
        },
        cancel: () => { const index = this.waiting.indexOf(item); if (index >= 0) this.waiting.splice(index, 1); reject(signal.reason); this.wake() },
      }
      this.waiting.push(item); signal.addEventListener('abort', item.cancel, { once: true }); this.wake()
      if (this.waiting.includes(item)) onQueued?.(true)
    })
  }
}
