import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PersistentShell } from '../apps/tools/src/shell.ts'

const transport = vi.hoisted(() => ({ chunks: [] as string[] }))
vi.mock('node-pty', () => ({ spawn: () => {
  let receive: (data: string) => void
  return {
    pid: 2147483647, kill() {}, onExit() {}, onData(listener: typeof receive) { receive = listener },
    write(command: string) {
      const ready = /RP_READY_([a-f0-9-]+)/.exec(command)
      if (ready) { queueMicrotask(() => receive(`\x1eRP_READY_${ready[1]}\x1f`)); return }
      const nonce = /RP_([a-f0-9-]+)_START/.exec(command)![1]
      queueMicrotask(() => {
        receive(`\x1eRP_${nonce}_START\x1f`)
        for (const chunk of transport.chunks) receive(chunk)
        receive(`\x1eRP_${nonce}_END:0\x1f`)
      })
    },
  }
} }))

it.each([8, 65536])('keeps streamed text, UTF-8 counts and full output stable across split CRLF at cap %i', async limit => {
  const directory = await mkdtemp(join(tmpdir(), 'rp-shell-chunks-')), shell = new PersistentShell(directory)
  const text = '文\r\n'.repeat(50) + 'tail\r', expected = text.replaceAll('\r\n', '\n'), streamed: string[] = []
  transport.chunks = [...text]
  try {
    const result = await shell.execute('synthetic transport', new AbortController().signal, 2000, chunk => streamed.push(chunk), limit)
    expect(result.output).toBe(limit === 8 ? '文\n文\n' : expected)
    expect(streamed.join('')).toBe(result.output)
    expect(result.outputBytes).toBe(Buffer.byteLength(expected))
    expect(result.truncated).toBe(limit === 8)
    if (result.outputFile) expect(await readFile(join(directory, result.outputFile), 'utf8')).toBe(expected)
  } finally { shell.close(); await rm(directory, { recursive: true, force: true }) }
})
