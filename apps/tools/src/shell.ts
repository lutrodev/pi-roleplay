import { randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import * as pty from 'node-pty'
import { RpError, requireValue } from '../../../packages/rp-core/src/errors.ts'
import type { ShellResult } from '../../../packages/protocol/src/tools.ts'

export class PersistentShell {
  private terminal: pty.IPty | null = null
  private active: ((data: string) => void) | null = null
  private fail: ((error: RpError) => void) | null = null
  private busy = false
  constructor(readonly cwd: string, readonly shell = '/bin/bash') {}

  async execute(command: string, signal: AbortSignal, timeoutMs = 300_000, onOutput?: (text: string) => void, maxOutputBytes = 65536): Promise<ShellResult> {
    requireValue(!this.busy, 'SHELL_BUSY', '当前故事的 Bash 仍在执行。', 409)
    requireValue(typeof command === 'string' && command.trim().length > 0 && command.length <= 65536 && !command.includes('\0'), 'INVALID_COMMAND', '命令不能为空，且不能超过 65536 字符。')
    requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300_000, 'INVALID_TIMEOUT', '命令超时必须在 1 到 300000 毫秒之间。')
    requireValue(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 1 && maxOutputBytes <= 1048576, 'INVALID_OUTPUT_LIMIT', '工具输出上限必须在 1 到 1048576 字节之间。')
    signal.throwIfAborted()
    this.busy = true
    const fresh = !this.terminal
    try {
      await this.initialize(signal)
      signal.throwIfAborted()
      const nonce = randomUUID(), start = `\x1eRP_${nonce}_START\x1f`, end = `\x1eRP_${nonce}_END:`
      return await new Promise<ShellResult>((resolve, reject) => {
        let pending = '', started = false, output = '', truncated = false, settled = false, outputBytes = 0, inlineBytes = 0
        let outputFd: number | undefined, outputFile: string | undefined
        const writeFull = (value: string) => {
          const bytes = Buffer.from(value)
          let offset = 0
          while (offset < bytes.length) offset += writeSync(outputFd!, bytes, offset)
        }
        const emit = (value: string) => {
          const cleaned = stripVTControlCharacters(value).replaceAll('\r\n', '\n')
          const bytes = Buffer.from(cleaned)
          outputBytes += bytes.length
          if (outputFd !== undefined) writeFull(cleaned)
          if (truncated) return
          let length = Math.min(bytes.length, maxOutputBytes - inlineBytes)
          while (length > 0 && (bytes[length]! & 0xc0) === 0x80) length--
          const accepted = bytes.subarray(0, length).toString('utf8')
          if (length < bytes.length) {
            const file = `.rp-output-${nonce}.log`
            outputFd = openSync(join(this.cwd, file), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
            outputFile = file
            writeFull(output); writeFull(cleaned)
            truncated = true
          }
          inlineBytes += length
          output += accepted
          if (accepted) onOutput?.(accepted)
        }
        const finish = (failure?: RpError, exitCode = 0) => {
          if (settled) return
          settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
          this.active = null; this.fail = null
          if (outputFd !== undefined) {
            try { fsyncSync(outputFd) } catch { failure = new RpError('TOOL_OUTPUT_FAILED', '完整工具输出无法保存，命令已停止，Bash 已重置。') }
            finally { try { closeSync(outputFd) } catch { failure = new RpError('TOOL_OUTPUT_FAILED', '完整工具输出无法保存，命令已停止，Bash 已重置。') }; outputFd = undefined }
          }
          const details = { output, truncated, outputBytes, ...(outputFile ? { outputFile } : {}) }
          if (failure) { this.reset(); reject(new RpError(failure.code, failure.message, failure.statusCode, { ...details, shellReset: true })) }
          else resolve({ ...details, exitCode, shellState: fresh ? 'new' : 'retained' })
        }
        const fail = (error: RpError) => {
          try { if (started) emit(pending) } catch { /* A disconnected consumer must not prevent cancellation. */ }
          pending = ''; finish(error)
        }
        const abort = () => fail(new RpError('TOOL_CANCELLED', '命令已取消，Bash 已重置；下次调用从故事目录和新环境开始。'))
        const timer = setTimeout(() => fail(new RpError('TOOL_TIMEOUT', '命令执行超时，Bash 已重置；下次调用从故事目录和新环境开始。')), timeoutMs)
        signal.addEventListener('abort', abort, { once: true })
        this.fail = fail
        this.active = data => {
          try {
            pending += data
            if (!started) {
              const at = pending.indexOf(start)
              if (at < 0) { pending = pending.slice(-start.length); return }
              started = true; pending = pending.slice(at + start.length)
            }
            const at = pending.indexOf(end)
            if (at >= 0) {
              const complete = /^(\d+)\x1f/.exec(pending.slice(at + end.length))
              if (complete) { emit(pending.slice(0, at)); pending = ''; finish(undefined, Number(complete[1])); return }
            }
            let safe = pending.length - end.length - 16
            if (safe > 0 && /[\uD800-\uDBFF]/.test(pending[safe - 1]!)) safe--
            if (safe > 0) { emit(pending.slice(0, safe)); pending = pending.slice(safe) }
          } catch { finish(new RpError('TOOL_OUTPUT_FAILED', '无法交付工具输出，命令已停止，Bash 已重置。')) }
        }
        try { this.terminal!.write(`builtin printf '\\036RP_${nonce}_START\\037'; builtin eval -- ${quote(command)}; __rp_command_status=$?; builtin printf '\\036RP_${nonce}_END:%s\\037' "$__rp_command_status"\n`) }
        catch { fail(new RpError('SHELL_EXITED', 'Bash 无法接收命令，下次调用会创建新环境。')) }
      })
    } catch (error) {
      if (signal.aborted && !(error instanceof RpError)) { this.reset(); throw new RpError('TOOL_CANCELLED', '命令已取消，Bash 已重置。', 400, { shellReset: true }) }
      throw error
    } finally { this.busy = false }
  }

  close() {
    this.fail?.(new RpError('TOOL_CANCELLED', '工具服务正在关闭，Bash 已重置。'))
    this.reset()
  }

  private reset() {
    const terminal = this.terminal
    this.terminal = null
    if (!terminal) return
    // With job control disabled, ordinary foreground/background children share this process group.
    try { process.kill(-terminal.pid, 'SIGKILL') } catch { try { terminal.kill('SIGKILL') } catch { /* Already exited. */ } }
  }

  private async initialize(signal: AbortSignal) {
    if (this.terminal) return
    const marker = `\x1eRP_READY_${randomUUID()}\x1f`
    let terminal: pty.IPty
    try {
      terminal = pty.spawn(this.shell, ['--noprofile', '--norc', '-i'], { cwd: this.cwd, cols: 120, rows: 30, name: 'xterm-256color', env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/home/rp', LANG: 'C.UTF-8', TERM: 'xterm-256color',
        PS1: '', PS2: '', PROMPT_COMMAND: '', HISTFILE: '/dev/null',
      } })
    } catch { throw new RpError('SHELL_START_FAILED', '无法启动 Bash，请检查工具服务的运行环境。') }
    this.terminal = terminal
    terminal.onData(data => { if (this.terminal === terminal) this.active?.(data) })
    terminal.onExit(event => {
      if (this.terminal !== terminal) return
      this.terminal = null
      this.fail?.(new RpError('SHELL_EXITED', `Bash 已退出（${event.exitCode}）；下次调用会创建新环境。`))
    })
    await new Promise<void>((resolve, reject) => {
      let pending = '', settled = false
      const finish = (error?: RpError) => {
        if (settled) return
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
        this.active = null; this.fail = null
        if (error) { this.reset(); reject(error) } else resolve()
      }
      const abort = () => finish(new RpError('TOOL_CANCELLED', 'Bash 初始化已取消。'))
      const timer = setTimeout(() => finish(new RpError('SHELL_START_FAILED', 'Bash 未能完成初始化。')), 5000)
      signal.addEventListener('abort', abort, { once: true })
      this.fail = finish
      this.active = data => {
        pending += data
        if (pending.includes(marker)) finish()
        else if (pending.length > 8192) pending = pending.slice(-8192)
      }
      try { terminal.write(`stty -echo; set +m; PS1=; PS2=; PROMPT_COMMAND=; bind 'set enable-bracketed-paste off'; builtin printf ${quote(marker)}\n`) }
      catch { finish(new RpError('SHELL_START_FAILED', 'Bash 初始化失败。')) }
    })
  }
}

function quote(value: string) { return "$'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\x1e', '\\036').replaceAll('\x1f', '\\037') + "'" }
