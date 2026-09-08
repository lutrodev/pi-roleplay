import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'

/** The local control socket is only mounted in the application, never in the tools container. */
export class Operations {
  private readonly marker: string
  private readonly requests = new Set<string>()
  private paused: boolean
  private socket?: Server
  constructor(readonly directory: string, readonly activity: () => { runs: number; background: number }, readonly resumed: () => void) {
    this.marker = join(directory, 'maintenance.lock')
    this.paused = existsSync(this.marker)
  }
  get quiesced() { return this.paused }
  register(app: FastifyInstance) {
    const gate = this
    app.addHook('onRequest', async request => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
      requireValue(!this.paused, 'MAINTENANCE', '正在备份，暂时不能修改或生成。请稍后重试。', 503)
    })
    app.addHook('onRoute', route => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      if (methods.every(method => ['GET', 'HEAD', 'OPTIONS'].includes(method))) return
      const original = route.handler
      route.handler = async function (request, reply) {
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return original.call(this, request, reply)
        requireValue(!gate.paused, 'MAINTENANCE', '正在备份，暂时不能修改或生成。请稍后重试。', 503)
        gate.requests.add(request.id)
        // Client disconnects do not imply that the asynchronous upload or mutation has finished.
        try { return await original.call(this, request, reply) }
        finally { gate.requests.delete(request.id) }
      }
    })
  }
  status() {
    let backup: unknown = null
    try {
      const file = join(this.directory, 'backup-status.json')
      if (lstatSync(file).size > 8192) throw new Error('Backup status too large')
      backup = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') backup = { status: 'unreadable' } }
    return { quiesced: this.paused, activeMutations: this.requests.size, ...this.activity(), backup }
  }
  command(command: string) {
    if (command === 'status') return this.status()
    if (command === 'quiesce') {
      const status = this.status()
      requireValue(status.runs === 0 && status.background === 0 && status.activeMutations === 0, 'APPLICATION_BUSY', '仍有生成、总结、回复建议或修改请求在进行，未进入备份状态。', 409)
      // Synchronous gate and durable marker close the gap between the idle check and stopping containers.
      writeFileSync(this.marker, 'backup\n', { mode: 0o600 })
      this.paused = true
    } else if (command === 'resume') {
      try { unlinkSync(this.marker) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      this.paused = false
      this.resumed()
    } else throw new RpError('INVALID_COMMAND', '控制命令只支持 status、quiesce、resume。')
    return this.status()
  }
  async listen(path: string) {
    if (existsSync(path)) {
      requireValue(lstatSync(path).isSocket(), 'INVALID_CONFIG', '控制接口路径已被普通文件占用。')
      unlinkSync(path)
    }
    const server = createServer(socket => {
      socket.setTimeout(5000, () => socket.destroy())
      let input = ''
      socket.on('data', bytes => {
        input += bytes.toString('utf8')
        if (input.length > 1024) { socket.destroy(); return }
        if (!input.includes('\n')) return
        try {
          const request = JSON.parse(input)
          socket.end(JSON.stringify({ ok: true, ...this.command(request.command) }) + '\n')
        } catch (error) {
          socket.end(JSON.stringify({ ok: false, code: error instanceof RpError ? error.code : 'CONTROL_FAILED', message: error instanceof RpError ? error.message : '本地控制操作失败。' }) + '\n')
        }
      })
      socket.on('error', () => socket.destroy())
    })
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
      chmodSync(path, 0o600)
      this.socket = server
    } catch (error) {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
      throw error
    }
  }
  async close() {
    const socket = this.socket; this.socket = undefined
    if (socket) await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  }
}
