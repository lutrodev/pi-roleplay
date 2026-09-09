import { createHash } from 'node:crypto'
import { RpError, requireValue } from '../../../packages/rp-core/src/errors.ts'
import type { ToolRequest, ToolWireEvent } from '../../../packages/protocol/src/tools.ts'
import { ToolFilesystem } from './filesystem.ts'
import { PersistentShell } from './shell.ts'
import { directoriesOverlap, workspaceAccess, workspaceDirectory } from '../../../packages/rp-core/src/workspace.ts'

interface Job {
  fingerprint: string
  controller: AbortController
  completion: Promise<ToolWireEvent>
  done: boolean
}

/** The app never retries a dispatch whose outcome is unknown. This cache only handles recent duplicate transport requests. */
export class ToolRunner {
  private readonly shells = new Map<string, { workspaceId: string; shell: PersistentShell }>()
  private readonly jobs = new Map<string, Job>()
  private readonly writing = new Set<string>()
  private readonly busyStories = new Set<string>()
  private closing = false
  constructor(readonly filesystem: ToolFilesystem) {}

  start(request: ToolRequest, onOutput: (text: string) => void) {
    requireValue(!this.closing, 'TOOLS_STOPPING', '工具服务正在关闭。', 503)
    const directory = workspaceDirectory(request.workspace.directory), access = workspaceAccess(request.workspace.access)
    const mutates = request.command.kind === 'bash' || request.command.kind === 'edit'
    requireValue(!mutates || access === 'read-write', 'WORKSPACE_READ_ONLY', '当前工作区只读，不能执行 Bash 或修改文件。', 403)
    const fingerprint = createHash('sha256').update(JSON.stringify([request.storyId, request.workspace, request.command])).digest('hex')
    const existing = this.jobs.get(request.id)
    if (existing) {
      requireValue(existing.fingerprint === fingerprint, 'TOOL_REQUEST_CONFLICT', '相同工具请求 ID 不能用于不同命令。', 409)
      requireValue(existing.done, 'TOOL_IN_PROGRESS', '该工具请求仍在运行。', 409)
      return existing
    }
    const retained = this.shells.get(request.storyId)
    if (retained && (retained.workspaceId !== directory || access === 'read-only')) this.reset(request.storyId)
    requireValue(!mutates || ![...this.writing].some(other => directoriesOverlap(other, directory)), 'WORKSPACE_BUSY', '共享此工作目录的故事仍有正在执行的文件或 Bash 操作。', 409)
    requireValue(this.activeCount < 8, 'TOOLS_BUSY', '工具服务已达到并发上限。', 429)
    if (mutates) { this.writing.add(directory); this.busyStories.add(request.storyId) }
    const controller = new AbortController()
    const job: Job = { fingerprint, controller, done: false, completion: Promise.resolve({ type: 'result', value: null }) }
    job.completion = Promise.resolve().then(async (): Promise<ToolWireEvent> => {
      try {
        let value: unknown
        if (request.command.kind === 'bash') {
          let shell = this.shells.get(request.storyId)?.shell
          if (request.command.reset) { shell?.close(); this.shells.delete(request.storyId); shell = undefined }
          if (!shell) {
            requireValue(this.shells.size < 32, 'SHELL_LIMIT', '最多保留 32 个故事的 Bash 环境，请先重置不再使用的环境。', 409)
            shell = new PersistentShell(await this.filesystem.workspace(directory, request.workspace.createIfMissing))
            this.shells.set(request.storyId, { workspaceId: directory, shell })
          }
          value = await shell.execute(request.command.command, controller.signal, request.command.timeoutMs, onOutput, request.command.maxOutputBytes)
        } else {
          controller.signal.throwIfAborted()
          value = await this.filesystem.execute(directory, request.command, request.workspace.createIfMissing)
        }
        return { type: 'result', value }
      } catch (error) {
        return error instanceof RpError ? { type: 'error', code: error.code, message: error.message, details: error.details }
          : { type: 'error', code: controller.signal.aborted ? 'TOOL_CANCELLED' : 'TOOL_FAILED', message: controller.signal.aborted ? '工具请求已取消。' : '工具执行失败，请检查路径和工具服务日志。' }
      } finally { job.done = true; if (mutates) { this.writing.delete(directory); this.busyStories.delete(request.storyId) } }
    })
    this.jobs.set(request.id, job)
    void job.completion.then(result => {
      // Downloads can be 25 MB. Retain the request identity, but not duplicate copies of large results.
      if (JSON.stringify(result).length > 262144) job.completion = Promise.resolve({ type: 'error', code: 'TOOL_RESULT_NOT_CACHED', message: '此请求已执行，结果过大未缓存；不会再次执行。' })
      const completed = [...this.jobs.entries()].filter(([, item]) => item.done)
      for (const [id] of completed.slice(0, Math.max(0, completed.length - 128))) this.jobs.delete(id)
    })
    return job
  }

  async cancel(id: string) {
    const job = this.jobs.get(id)
    requireValue(job, 'TOOL_REQUEST_NOT_FOUND', '工具请求不存在，无法确认执行状态。', 404)
    const cancellationRequested = !job.done
    if (cancellationRequested) job.controller.abort()
    // Acknowledge only after the command and its workspace lock have settled.
    await job.completion
    return { finished: job.done, cancellationRequested }
  }

  reset(storyId: string) {
    requireValue(!this.busyStories.has(storyId), 'WORKSPACE_BUSY', '先停止正在运行的工具，再重置 Bash。', 409)
    this.shells.get(storyId)?.shell.close(); this.shells.delete(storyId)
  }

  get activeCount() { return [...this.jobs.values()].filter(job => !job.done).length }
  status() { return { active: this.activeCount, shells: this.shells.size, closing: this.closing } }
  async close() {
    this.closing = true
    for (const job of this.jobs.values()) if (!job.done) job.controller.abort()
    for (const { shell } of this.shells.values()) shell.close()
    await Promise.all([...this.jobs.values()].map(job => job.completion))
    this.shells.clear()
  }
}
