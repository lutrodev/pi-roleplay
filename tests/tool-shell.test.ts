import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PersistentShell } from '../apps/tools/src/shell.ts'

describe('real persistent Bash', () => {
  let directory: string, shell: PersistentShell
  const signal = () => new AbortController().signal
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'rp-tools-shell-')))
    shell = new PersistentShell(directory)
  })
  afterEach(async () => { shell.close(); await rm(directory, { recursive: true, force: true }) })

  it('keeps directory, exports and functions, preserves exit codes and multiline quoting', async () => {
    expect(await shell.execute("mkdir nested; cd nested; export RP_TEST_VALUE='你好'; rp_test_fn() { printf '%s' \"$RP_TEST_VALUE\"; }", signal())).toMatchObject({ exitCode: 0, shellState: 'new' })
    const next = await shell.execute('rp_test_fn\nprintf "\\n"\npwd\nfalse', signal())
    expect(next).toMatchObject({ exitCode: 1, shellState: 'retained', truncated: false })
    expect(next.output).toBe(`你好\n${directory}/nested\n`)
    expect(await shell.execute('printf "%s" "a\u0027b\\\"c"', signal())).toMatchObject({ output: "a'b\"c", exitCode: 0 })
  })

  it('does not pass service credentials to Bash', async () => {
    process.env.RP_SYNTHETIC_SERVICE_SECRET = 'not-a-real-credential'
    try { expect(await shell.execute('printf "%s" "${RP_SYNTHETIC_SERVICE_SECRET-unset}"', signal())).toMatchObject({ output: 'unset' }) }
    finally { delete process.env.RP_SYNTHETIC_SERVICE_SECRET }
  })

  it('reports truncation, then continues using the same healthy shell', async () => {
    const chunks: string[] = []
    const result = await shell.execute('printf "%070000d" 0', signal(), 2000, value => chunks.push(value))
    expect(result.truncated).toBe(true)
    expect(result.output.length).toBe(65536)
    expect(chunks.join('')).toBe(result.output)
    expect(result.outputFile).toMatch(/^\.rp-output-[0-9a-f-]+\.log$/)
    expect(await readFile(join(directory, result.outputFile!), 'utf8')).toBe('0'.repeat(70000))
    expect(result.outputBytes).toBe(70000)
    expect(await shell.execute('printf done', signal())).toMatchObject({ output: 'done', shellState: 'retained' })
  })

  it('limits UTF-8 bytes without splitting characters, retains complete output and keeps the archive at the workspace root after cd', async () => {
    await shell.execute('mkdir nested; cd nested', signal())
    const text = '海🌊岸'.repeat(100), chunks: string[] = []
    const result = await shell.execute(`printf '%s' '${text}'`, signal(), 2000, value => chunks.push(value), 8)
    expect(result.output).toBe('海🌊')
    expect(Buffer.byteLength(result.output)).toBe(7)
    expect(result.outputBytes).toBe(Buffer.byteLength(text))
    expect(chunks.join('')).toBe(result.output)
    expect(await readFile(join(directory, result.outputFile!), 'utf8')).toBe(text)
    const normal = await shell.execute('printf done', signal(), 2000, undefined, 4)
    expect(normal).toMatchObject({ output: 'done', truncated: false, outputBytes: 4 })
    expect(normal.outputFile).toBeUndefined()
  })

  it('retains the full overflow output when the command subsequently times out', async () => {
    try {
      await shell.execute('printf "%01000d" 0; sleep 10', signal(), 100, undefined, 16)
      throw new Error('Expected command timeout')
    } catch (error) {
      expect(error).toMatchObject({ code: 'TOOL_TIMEOUT', details: { output: '0'.repeat(16), truncated: true, outputBytes: 1000, shellReset: true } })
      const details = (error as { details: { outputFile: string } }).details
      expect(await readFile(join(directory, details.outputFile), 'utf8')).toBe('0'.repeat(1000))
    }
  })

  it('resets after timeout and shell exit without applying stale exit events to a new shell', async () => {
    await shell.execute('export RP_TEST_STATE=old', signal())
    await expect(shell.execute('printf before; sleep 10', signal(), 70)).rejects.toMatchObject({ code: 'TOOL_TIMEOUT', details: { output: 'before', shellReset: true } })
    expect(await shell.execute('printf "%s" "${RP_TEST_STATE-fresh}"', signal())).toMatchObject({ output: 'fresh', shellState: 'new' })
    await expect(shell.execute('exit 7', signal())).rejects.toMatchObject({ code: 'SHELL_EXITED' })
    expect(await shell.execute('printf next', signal())).toMatchObject({ output: 'next', shellState: 'new' })
  })

  it('rejects simultaneous commands and cancels the active command with output retained', async () => {
    const controller = new AbortController()
    const first = shell.execute('printf started; sleep 10', controller.signal)
    const failed = expect(first).rejects.toMatchObject({ code: 'TOOL_CANCELLED', details: { shellReset: true } })
    await expect(shell.execute('printf should-not-run', signal())).rejects.toMatchObject({ code: 'SHELL_BUSY' })
    setTimeout(() => controller.abort(), 80)
    await failed
    expect(await shell.execute('printf recovered', signal())).toMatchObject({ output: 'recovered', shellState: 'new' })
  })

  it('stops the shell if output delivery fails, and can start cleanly again', async () => {
    await expect(shell.execute('printf "%01000d" 0; sleep 10', signal(), 2000, () => { throw new Error('consumer closed') })).rejects.toMatchObject({ code: 'TOOL_OUTPUT_FAILED' })
    expect(await shell.execute('printf available', signal())).toMatchObject({ output: 'available', shellState: 'new' })
  })
})
