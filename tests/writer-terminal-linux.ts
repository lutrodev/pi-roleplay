import assert from 'node:assert/strict'
import type { ShellResult, ToolCommand } from '../packages/protocol/src/tools.ts'
import { terminalExampleFiles, terminalWriterHistory, TERMINAL_EXAMPLE_DIRECTORY } from '../packages/rp-core/src/agents/writer-terminal-example.ts'

/** Runs through the isolated tools HTTP service. Only the fixture's absolute working root is mapped. */
export async function verifyWriterTerminalExample(request: (command: ToolCommand) => Promise<unknown>, workspace: string) {
  const actualDirectory = `${workspace}/archive/visiting-days`, config = terminalWriterHistory()
  await request({ kind: 'bash', command: 'mkdir -p archive/visiting-days/{chapters,characters,config,requests,state}', reset: true })
  let previous: Record<string, string> = {}, checked = 0
  for (const index of [0, 1] as const) {
    const files = terminalExampleFiles(index)
    for (const [path, fileText] of Object.entries(files)) if (previous[path] !== fileText)
      await request({ kind: 'edit', command: 'write', path: `archive/visiting-days/${path}`, fileText })
    previous = files
    for (const [stepIndex, step] of config.rounds[index]!.steps.slice(0, -1).entries()) {
      const { command } = JSON.parse(step.argumentsJson) as { command: string }
      const expected = JSON.parse(step.resultJson) as ShellResult
      const result = await request({ kind: 'bash', command: command.replaceAll(TERMINAL_EXAMPLE_DIRECTORY, actualDirectory),
        reset: index === 0 && stepIndex === 0, maxOutputBytes: 65536 }) as ShellResult
      assert.equal(result.exitCode, expected.exitCode, command)
      assert.equal(result.truncated, false, command)
      assert.equal(result.shellState, expected.shellState, command)
      assert.equal(result.outputBytes, Buffer.byteLength(result.output), command)
      assert.equal(result.output.replaceAll(actualDirectory, TERMINAL_EXAMPLE_DIRECTORY), expected.output, command)
      checked++
    }
  }
  assert.equal(checked, 20)
  return 'Writer terminal example: 12/10 history steps, all 20 Linux commands verified against isolated persistent Bash, including UTF-8 statistics and cross-round excerpts'
}
