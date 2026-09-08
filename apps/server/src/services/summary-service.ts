import { randomUUID } from 'node:crypto'
import { estimateTextTokens, planSummary, SUMMARY_INSTRUCTION, SUMMARY_MAX_TOKENS, summaryStillApplies, validateSummary, type SummaryPlan } from '../../../../packages/rp-core/src/context/summary.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { JsonObject, MaintenanceRecord, ModelRoute, SummaryCandidate } from '../../../../packages/rp-core/src/types.ts'
import type { StoryRepository } from '../storage/story-repository.ts'
import type { ModelRegistry } from '../runtime/models.ts'

interface Job { controller: AbortController; done: Promise<boolean>; metadata: MaintenanceRecord }
export interface ContextPressure { route: ModelRoute; text: string }

/** Auxiliary summaries preserve the journal and never execute tools or replay a main run. */
export class SummaryService {
  private readonly jobs = new Map<string, Job>()
  private closing = false
  constructor(readonly stories: StoryRepository, readonly models: ModelRegistry, readonly onFault: (error: unknown) => void, readonly onSettled: () => void = () => {}) {}

  startManual(storyId: string, expectedRevision: number, requestId: string, route: ModelRoute) {
    return this.stories.database.transaction(() => {
      const key = `summary-request:${requestId}`, previous = this.stories.findEvent(storyId, key)
      if (previous?.type === 'maintenance.status') {
        requireValue(previous.data.sourceRevision === expectedRevision, 'REQUEST_CONFLICT', '同一次总结请求包含不同内容。', 409)
        return { id: previous.data.id, duplicate: true }
      }
      this.stories.assertIdle(storyId); this.stories.assertRevision(storyId, expectedRevision)
      requireValue(!this.jobs.has(storyId), 'SUMMARY_BUSY', '后台前情总结尚未结束，请稍后再试。', 409)
      const plan = planSummary(this.stories.snapshot(storyId), { retainLatestExchange: false })
      requireValue(plan, 'SUMMARY_NOT_NEEDED', '目前没有尚未总结的对话。')
      this.assertCapacity(); this.models.resolve(route)
      const metadata: MaintenanceRecord = { id: randomUUID(), kind: 'summary', trigger: 'manual', status: 'running', sourceRevision: expectedRevision }
      this.stories.append(storyId, { type: 'maintenance.status', data: metadata }, key)
      this.launch(storyId, route, plan, metadata, false)
      return { id: metadata.id, duplicate: false }
    })
  }

  /** A pressure candidate from turn N only lands before the next main turn, after N succeeded. */
  async beforeRun(runId: string, signal: AbortSignal) {
    const run = this.stories.run(runId), pending = this.jobs.get(run.storyId)
    if (pending?.metadata.trigger === 'pressure' && pending.metadata.runId) this.settleRun(pending.metadata.runId)
    if (pending) {
      const cancel = () => pending.controller.abort(signal.reason)
      signal.addEventListener('abort', cancel, { once: true })
      try { signal.throwIfAborted(); await pending.done; signal.throwIfAborted() }
      finally { signal.removeEventListener('abort', cancel) }
    }
    this.stories.database.transaction(() => {
      const snapshot = this.stories.snapshot(run.storyId), candidate = snapshot.summaryCandidate
      if (!candidate || candidate.triggerRunId === runId) return
      const previous = this.stories.run(candidate.triggerRunId), metadata = snapshot.maintenance.summary!
      if (previous.status !== 'completed' || !summaryStillApplies(snapshot, candidate.source)) {
        this.status(run.storyId, metadata, 'discarded', 'SUMMARY_STALE', '上一轮未完成或总结来源已变化，已保留原始对话。'); return
      }
      this.land(run.storyId, candidate)
      this.status(run.storyId, metadata, 'completed')
    })
  }

  /** Stop work belonging to an unsuccessful turn as soon as its terminal status is durable. */
  settleRun(runId: string) {
    const run = this.stories.run(runId)
    if (!['failed', 'cancelled', 'interrupted'].includes(run.status)) return
    const message = '上一轮未完成，已停止会话总结并保留原始对话。'
    const pending = this.jobs.get(run.storyId)
    if (pending?.metadata.trigger === 'pressure' && pending.metadata.runId === runId) {
      pending.controller.abort(new RpError('SUMMARY_STALE', message))
    }
    const snapshot = this.stories.snapshot(run.storyId)
    if (snapshot.summaryCandidate?.triggerRunId === runId) this.status(run.storyId, snapshot.maintenance.summary!, 'discarded', 'SUMMARY_STALE', message)
  }

  pressure(runId: string, contexts: ContextPressure[], summaryRoute: ModelRoute) {
    const run = this.stories.run(runId)
    if (this.closing || this.jobs.has(run.storyId) || this.jobs.size >= 2 || this.stories.snapshot(run.storyId).summaryCandidate) return
    const pressured = contexts.some(({ route, text }) => {
      const { model } = this.models.resolve(route)
      return estimateTextTokens(text) + this.models.outputBudget(route) >= model.contextWindow * 0.8
    })
    if (!pressured) return
    const plan = planSummary(this.stories.snapshot(run.storyId), { currentRunId: runId, retainLatestExchange: false })
    if (!plan) return
    const metadata: MaintenanceRecord = { id: randomUUID(), kind: 'summary', trigger: 'pressure', status: 'running', runId }
    this.stories.append(run.storyId, { type: 'maintenance.status', data: metadata })
    this.launch(run.storyId, summaryRoute, plan, metadata, true)
  }

  /** Called at most once by each executor, and only after a provider reports context overflow. */
  async overflow(runId: string, route: ModelRoute, signal: AbortSignal) {
    signal.throwIfAborted()
    const run = this.stories.run(runId), pending = this.jobs.get(run.storyId)
    if (pending) { pending.controller.abort(); await pending.done; signal.throwIfAborted() }
    this.assertCapacity()
    const plan = planSummary(this.stories.snapshot(run.storyId), { currentRunId: runId, retainLatestExchange: true })
    requireValue(plan, 'CONTEXT_OVERFLOW', '模型上下文已满，且没有可压缩的较早对话。请缩短资料、本轮输入或改用更大上下文的模型。', 502)
    const metadata: MaintenanceRecord = { id: randomUUID(), kind: 'summary', trigger: 'overflow', status: 'running', runId }
    this.stories.append(run.storyId, { type: 'maintenance.status', data: metadata })
    const job = this.launch(run.storyId, route, plan, metadata, false, signal)
    const landed = await job.done
    signal.throwIfAborted()
    requireValue(landed, 'CONTEXT_OVERFLOW', '上下文超限后的前情总结未成功，草稿与工具记录已保留。请检查总结记录后调整资料或模型。', 502)
  }

  async cancel(storyId: string, id: string) {
    requireValue(this.stories.snapshot(storyId).maintenance.summary?.id === id, 'SUMMARY_CHANGED', '当前总结任务已变化，请刷新后查看。', 409)
    const job = this.jobs.get(storyId)
    requireValue(!job || job.metadata.id === id, 'SUMMARY_CHANGED', '当前总结任务已变化，请刷新后查看。', 409)
    if (job) { job.controller.abort(); await job.done }
    const snapshot = this.stories.snapshot(storyId)
    if (snapshot.summaryCandidate?.id === id) this.status(storyId, snapshot.maintenance.summary!, 'discarded', 'SUMMARY_CANCELLED', '已停止本次总结，原始对话保留。')
    return this.stories.snapshot(storyId).maintenance.summary
  }

  get activeCount() { return this.jobs.size }
  hasStoryJob(storyId: string) { return this.jobs.has(storyId) }
  async idle() { await Promise.all([...this.jobs.values()].map(job => job.done)) }
  async close() { this.closing = true; for (const job of this.jobs.values()) job.controller.abort(); await this.idle() }
  recover() {
    for (const story of [...this.stories.list(false), ...this.stories.list(true)]) {
      const previous = this.stories.snapshot(story.id).maintenance.summary
      if (previous?.status === 'running') this.status(story.id, previous, 'discarded', 'PROCESS_INTERRUPTED', '服务重启中断了总结；原始对话保留，不自动重复调用。')
      else if (previous?.status === 'ready' && previous.runId && this.stories.run(previous.runId).status !== 'completed' && !this.stories.hasCommitted(previous.runId)) {
        this.status(story.id, previous, 'discarded', 'SUMMARY_STALE', '上一轮未完成，已停止会话总结并保留原始对话。')
      }
    }
  }

  private assertCapacity() { requireValue(!this.closing && this.jobs.size < 2, 'SUMMARY_BUSY', '后台总结繁忙或服务正在关闭，请稍后再试。', 409) }

  private launch(storyId: string, route: ModelRoute, plan: SummaryPlan, metadata: MaintenanceRecord, defer: boolean, outerSignal?: AbortSignal) {
    const controller = new AbortController(), timeout = AbortSignal.timeout(60000), signal = AbortSignal.any([controller.signal, timeout, ...(outerSignal ? [outerSignal] : [])])
    const job: Job = { controller, metadata, done: Promise.resolve(false) }
    this.jobs.set(storyId, job)
    // Begin after the transaction that records acceptance has committed.
    job.done = Promise.resolve().then(async () => {
      try {
        signal.throwIfAborted()
        const { model, thinkingLevel } = this.models.resolve(route), maxTokens = Math.min(SUMMARY_MAX_TOKENS, model.maxTokens)
        requireValue(estimateTextTokens(SUMMARY_INSTRUCTION + plan.prompt) + maxTokens < model.contextWindow, 'SUMMARY_INPUT_TOO_LARGE', '总结来源超过所选模型的上下文窗口，请改用更大上下文的模型。')
        this.stories.append(storyId, { type: 'maintenance.model', data: { id: metadata.id, role: 'request', message: { route: { ...route }, systemPrompt: SUMMARY_INSTRUCTION, prompt: plan.prompt, maxTokens } } })
        const result = await this.models.stream(model, { systemPrompt: SUMMARY_INSTRUCTION, messages: [{ role: 'user', content: plan.prompt, timestamp: Date.now() }] }, {
          signal, timeoutMs: 60000, maxRetries: 0, maxTokens, toolChoice: 'none', ...(thinkingLevel === 'off' ? {} : { reasoning: thinkingLevel }),
        }).result()
        signal.throwIfAborted()
        this.stories.append(storyId, { type: 'maintenance.model', data: { id: metadata.id, role: 'response', message: JSON.parse(JSON.stringify(result)) as JsonObject } })
        requireValue(result.stopReason === 'stop' && result.content.every(part => part.type !== 'toolCall'), 'SUMMARY_INCOMPLETE', '模型没有返回完整的会话总结，原文已保留。')
        const text = validateSummary(result.content.filter(part => part.type === 'text').map(part => part.text).join(''), plan.originalTokens)
        const { prompt: _prompt, ...source } = plan
        return this.stories.database.transaction(() => {
          requireValue(summaryStillApplies(this.stories.snapshot(storyId), source), 'SUMMARY_STALE', '总结来源已变化，已忽略过期结果。')
          const candidate: SummaryCandidate = { id: metadata.id, triggerRunId: metadata.runId ?? '', source, text }
          if (defer) {
            this.stories.append(storyId, { type: 'summary.candidate', data: candidate })
            this.status(storyId, metadata, 'ready', undefined, '前情总结已就绪，将在下一轮开始时校验并应用。')
          } else { this.land(storyId, candidate); this.status(storyId, metadata, 'completed') }
          return true
        })
      } catch (error) {
        const cancellation = signal.aborted && signal.reason instanceof RpError && signal.reason.code === 'SUMMARY_STALE' ? signal.reason : undefined
        const code = timeout.aborted ? 'SUMMARY_TIMEOUT' : signal.aborted ? cancellation?.code ?? 'SUMMARY_CANCELLED' : error instanceof RpError ? error.code : 'SUMMARY_FAILED'
        const message = timeout.aborted ? '会话总结超时，原始对话保留。' : signal.aborted ? cancellation?.message ?? '总结已取消或服务关闭，原始对话保留。' : error instanceof RpError ? error.message : '会话总结生成失败，原始对话保留。'
        this.status(storyId, metadata, code === 'SUMMARY_CANCELLED' || code === 'SUMMARY_STALE' ? 'discarded' : 'failed', code, message)
        return false
      }
    }).catch(error => { this.onFault(error); return false }).finally(() => { if (this.jobs.get(storyId) === job) this.jobs.delete(storyId); if (!this.closing) this.onSettled() })
    return job
  }

  private land(storyId: string, candidate: SummaryCandidate) {
    this.stories.append(storyId, { type: 'summary.created', data: { throughMessageId: candidate.source.throughMessageId, sourceMessageIds: candidate.source.sourceMessageIds, text: candidate.text } }, `summary:${candidate.id}`)
  }
  private status(storyId: string, metadata: MaintenanceRecord, status: MaintenanceRecord['status'], code?: string, message?: string) {
    const { code: _code, message: _message, ...base } = metadata
    this.stories.append(storyId, { type: 'maintenance.status', data: { ...base, status, ...(code ? { code } : {}), ...(message ? { message } : {}) } })
  }
}
