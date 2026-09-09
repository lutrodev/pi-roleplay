import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { StoryRepository } from '../storage/story-repository.ts'

/** Stories advance independently; the database serializes turns within each story. Model requests have their own limits. */
export class RunQueue {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private pumping = false
  private stopped = false
  private wakeRequested = false
  constructor(readonly stories: StoryRepository, readonly execute: (runId: string, signal: AbortSignal) => Promise<unknown>,
    readonly onFault: (error: unknown) => void, readonly paused: () => boolean = () => false, readonly promoteInput: () => boolean = () => false,
    readonly onRunSettled: (runId: string) => void = () => {}) {}

  start() { this.stories.recoverInterrupted(); this.wake() }
  wake() {
    if (this.stopped || this.paused()) return
    if (this.pumping) { this.wakeRequested = true; return }
    this.pumping = true
    try {
      do {
        this.wakeRequested = false
        while (!this.stopped && !this.paused()) {
          this.promoteInput()
          const run = this.stories.nextQueued()
          if (!run) break
          const controller = new AbortController()
          this.stories.setRunStatus(run.id, 'running')
          // Register before executing: tools can synchronously enqueue, ask or cancel another run.
          const done = Promise.resolve().then(() => this.executeRun(run.id, controller)).finally(() => {
            this.active.delete(run.id)
            try { this.onRunSettled(run.id) } finally { this.wake() }
          }).catch(this.onFault)
          this.active.set(run.id, { controller, done })
        }
      } while (this.wakeRequested && !this.stopped && !this.paused())
    } catch (error) { this.onFault(error) }
    finally { this.pumping = false }
  }
  async idle() { while (this.active.size) await Promise.all([...this.active.values()].map(run => run.done)) }

  async cancel(runId: string) {
    const run = this.stories.run(runId)
    if (run.status === 'queued') { this.stories.setRunStatus(runId, 'cancelled'); this.wake(); return }
    const active = this.active.get(runId)
    requireValue(active, 'RUN_STATE_CONFLICT', '这次生成已不在运行。', 409)
    active.controller.abort(new RpError('RUN_CANCELLED', '已停止生成。'))
  }

  async close() {
    this.stopped = true
    for (const run of this.active.values()) run.controller.abort(new RpError('PROCESS_INTERRUPTED', '服务停止中断了生成，草稿已保留。'))
    await this.idle()
  }

  private async executeRun(runId: string, controller: AbortController) {
    try {
      controller.signal.throwIfAborted()
      await this.execute(runId, controller.signal)
      if (!this.stories.hasCommitted(runId)) controller.signal.throwIfAborted()
      this.stories.setRunStatus(runId, 'completed')
    } catch (error) {
      // Cancellation or process shutdown cannot undo an already durable narrative transaction.
      if (this.stories.hasCommitted(runId)) {
        this.stories.setRunStatus(runId, 'completed', controller.signal.aborted ? undefined : { code: 'POST_COMMIT_FAILED', message: '正文已保存，后续处理发生错误，请查看执行记录。' })
        if (!controller.signal.aborted) this.onFault(error)
        return
      }
      const failure = controller.signal.aborted ? controller.signal.reason : error
      const code = failure instanceof RpError ? failure.code : 'RUN_FAILED'
      const message = failure instanceof RpError ? failure.message : '这次生成失败，已保留草稿与工具记录。'
      const status = code === 'PROCESS_INTERRUPTED' ? 'interrupted' : controller.signal.aborted ? 'cancelled' : 'failed'
      this.stories.setRunStatus(runId, status, { code, message })
      if (!(failure instanceof RpError) && !controller.signal.aborted) this.onFault(error)
    }
  }
}
