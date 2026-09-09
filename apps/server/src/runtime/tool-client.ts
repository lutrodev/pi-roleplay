import { randomUUID } from 'node:crypto'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { ToolCommand, ToolRequest, ToolWireEvent } from '../../../../packages/protocol/src/tools.ts'
import type { WorkspaceTarget } from '../../../../packages/rp-core/src/workspace.ts'
import { WorkspaceDispatch } from './workspace-dispatch.ts'

interface ExecuteOptions { signal: AbortSignal; requestId?: string; onOutput?: (text: string) => void }

export class ToolClient {
  private readonly endpoint: string
  private readonly dispatch = new WorkspaceDispatch()
  constructor(baseUrl: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch,
    private readonly workspaceFor: (storyId: string) => WorkspaceTarget = storyId => ({ directory: storyId, access: 'read-write', createIfMissing: true })) {
    const url = new URL(baseUrl)
    requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'INVALID_TOOLS_CONFIG', '工具服务地址应为独立 HTTP(S) 服务地址。')
    requireValue(token.length >= 32 && !/[\r\n]/.test(token), 'INVALID_TOOLS_CONFIG', '工具服务令牌不正确。')
    this.endpoint = url.origin
  }

  async execute(storyId: string, command: ToolCommand, options: ExecuteOptions): Promise<unknown> {
    options.signal.throwIfAborted()
    const workspace = this.workspace(storyId)
    const release = await this.dispatch.acquire(workspace.directory, command.kind === 'bash' || command.kind === 'edit', options.signal)
    try { options.signal.throwIfAborted(); return await this.executeNow(storyId, workspace, command, options) }
    finally { release() }
  }
  private async executeNow(storyId: string, workspace: WorkspaceTarget, command: ToolCommand, options: ExecuteOptions): Promise<unknown> {
    const id = options.requestId ?? randomUUID()
    const request: ToolRequest = { id, storyId, workspace, command }
    const controller = new AbortController()
    let cancelRequest: Promise<unknown> | undefined
    const cancel = () => {
      cancelRequest ??= this.control(`/v1/jobs/${id}/cancel`).catch(() => undefined)
      controller.abort()
    }
    options.signal.addEventListener('abort', cancel, { once: true })
    const deadline = setTimeout(cancel, command.kind === 'bash' ? (command.timeoutMs ?? 300_000) + 10_000 : 30_000)
    try {
      const response = await this.fetcher(this.endpoint + '/v1/execute', { method: 'POST', headers: this.headers(), body: JSON.stringify(request), signal: controller.signal, redirect: 'error' })
      if (!response.ok) throw await httpError(response)
      requireValue(response.body && response.headers.get('content-type')?.startsWith('application/x-ndjson'), 'TOOL_PROTOCOL_ERROR', '工具服务没有返回预期的数据流。', 502)
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
      let buffer = '', bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          requireValue(bytes <= 36 * 1024 * 1024, 'TOOL_OUTPUT_TOO_LARGE', '工具输出超过传输上限。', 502)
          buffer += decoder.decode(chunk.value, { stream: true })
          let end: number
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
            const event = JSON.parse(line) as ToolWireEvent
            if (event.type === 'output') { requireValue(typeof event.text === 'string', 'TOOL_PROTOCOL_ERROR', '工具输出格式错误。', 502); options.onOutput?.(event.text) }
            else if (event.type === 'result') return event.value
            else if (event.type === 'error') throw new RpError(event.code, event.message, 400, event.details)
            else throw new RpError('TOOL_PROTOCOL_ERROR', '工具服务返回未知事件。', 502)
          }
        }
        throw new RpError('TOOL_OUTCOME_UNKNOWN', '工具连接已结束，但没有最终结果；请检查文件或工具记录，不会自动重试命令。', 502)
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    } catch (error) {
      if (options.signal.aborted) throw new RpError('TOOL_CANCELLED', '已请求停止工具；执行前已产生的文件变化可能保留。')
      if (error instanceof RpError) throw error
      throw new RpError('TOOL_OUTCOME_UNKNOWN', '工具连接中断，执行结果无法确认；请检查文件或工具记录，不会自动重试命令。', 502)
    } finally {
      clearTimeout(deadline); options.signal.removeEventListener('abort', cancel)
      await cancelRequest
    }
  }

  async health() {
    const response = await this.fetcher(this.endpoint + '/health', { headers: this.headers(), signal: AbortSignal.timeout(3000), redirect: 'error' })
    if (!response.ok) throw await httpError(response)
    return response.json() as Promise<{ ok: boolean; active: number; shells: number; closing: boolean }>
  }
  workspace(storyId: string): WorkspaceTarget {
    const { directory, access, createIfMissing } = this.workspaceFor(storyId)
    return { directory, access, createIfMissing }
  }
  async prepareDirectory(directory: string) {
    const response = await this.fetcher(this.endpoint + '/v1/workspaces/prepare', { method: 'POST', headers: this.headers(), body: JSON.stringify({ directory }), signal: AbortSignal.timeout(10000), redirect: 'error' })
    if (!response.ok) throw await httpError(response)
    return response.json()
  }
  reset(storyId: string) { return this.control(`/v1/shells/${storyId}/reset`) }
  private headers() { return { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' } }
  private async control(path: string) {
    const response = await this.fetcher(this.endpoint + path, { method: 'POST', headers: { authorization: 'Bearer ' + this.token }, signal: AbortSignal.timeout(3000), redirect: 'error' })
    if (!response.ok) throw await httpError(response)
    return response.json()
  }
}

async function httpError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
  return new RpError(payload?.error?.code ?? 'TOOLS_UNAVAILABLE', payload?.error?.message ?? '工具服务不可用，请检查部署状态。', response.status)
}
