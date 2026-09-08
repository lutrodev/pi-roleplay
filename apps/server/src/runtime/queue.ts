import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { StoryRepository } from '../storage/story-repository.ts'

/** Durable SQLite queue with exactly one active main run in this process. */
export class RunQueue {
  private draining: Promise<void> | null = null
  private active: { id: string; controller: AbortController } | null = null
  private stopped = false
  private wakeRequested = false
  constructor(readonly stories: StoryRepository, readonly execute: (runId: string, signal: AbortSignal) => Promise<unknown>,
    readonly onFault: (error: unknown) => void, readonly paused: () => boolean = () => false, readonly promoteInput: () => boolean = () => false,
    readonly onRunSettled: (runId: string) => void = () => {}) {}

  start() { this.stories.recoverInterrupted(); this.wake() }
  wake() {
    if (this.stopped || this.paused()) return
    if (this.draining) { this.wakeRequested = true; return }
    this.wakeRequested = false
    this.draining = this.drain().catch(this.onFault).finally(() => {
      this.draining = null
      if (this.wakeRequested) this.wake()
    })
  }
  async idle() { await this.draining }

  async cancel(runId: string) {
    const run = this.stories.run(runId)
    if (run.status === 'queued') { this.stories.setRunStatus(runId, 'cancelled'); return }
    requireValue(this.active?.id === runId, 'RUN_STATE_CONFLICT', '这次生成已不在运行。', 409)
    this.active.controller.abort(new RpError('RUN_CANCELLED', '已停止生成。'))
  }

  async close() {
    this.stopped = true
    this.active?.controller.abort(new RpError('PROCESS_INTERRUPTED', '服务停止中断了生成，草稿已保留。'))
    await this.draining
  }

  private async drain() {
    while (!this.stopped && !this.paused()) {
      this.promoteInput()
      const run = this.stories.nextQueued()
      if (!run) return
      const controller = new AbortController()
      this.active = { id: run.id, controller }
      this.stories.setRunStatus(run.id, 'running')
      try {
        await this.execute(run.id, controller.signal)
        if (!this.stories.hasCommitted(run.id)) controller.signal.throwIfAborted()
        this.stories.setRunStatus(run.id, 'completed')
      } catch (error) {
        // Cancellation or process shutdown cannot undo an already durable narrative transaction.
        if (this.stories.hasCommitted(run.id)) {
          this.stories.setRunStatus(run.id, 'completed', controller.signal.aborted ? undefined : { code: 'POST_COMMIT_FAILED', message: '正文已保存，后续处理发生错误，请查看执行记录。' })
          if (!controller.signal.aborted) this.onFault(error)
          continue
        }
        const failure = controller.signal.aborted ? controller.signal.reason : error
        const code = failure instanceof RpError ? failure.code : 'RUN_FAILED'
        const message = failure instanceof RpError ? failure.message : '这次生成失败，已保留草稿与工具记录。'
        const status = code === 'PROCESS_INTERRUPTED' ? 'interrupted' : controller.signal.aborted ? 'cancelled' : 'failed'
        this.stories.setRunStatus(run.id, status, { code, message })
        if (!(failure instanceof RpError) && !controller.signal.aborted) this.onFault(error)
      } finally { this.active = null; this.onRunSettled(run.id) }
    }
  }
}
