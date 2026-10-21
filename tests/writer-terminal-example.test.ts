import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { simpleTerminalWriterHistory, terminalWriterHistory } from '../packages/rp-core/src/agents/writer-history-example.ts'
import { terminalExampleFiles } from '../packages/rp-core/src/agents/writer-terminal-example.ts'
import { visitingStory } from '../packages/rp-core/src/agents/writer-terminal-story.ts'
import { compileWriterHistory, normalizeWriterHistory, writerHistoryArchive, writerHistoryIssues, writerHistorySize } from '../packages/rp-core/src/agents/writer-history.ts'
import { terminalExamples, terminalRequestPreview } from '../packages/rp-core/src/agents/writer-terminal.ts'

it('preserves the complete original two-round radio-station preset independently of the expanded version', () => {
  const simple = simpleTerminalWriterHistory(), expanded = terminalWriterHistory()
  // The serialized preset at c0c5e71, including its original dispatch and output-field instructions.
  expect(createHash('sha256').update(JSON.stringify(simple)).digest('hex')).toBe('580362346ed5bfd495971ba80e8b890043f68519c2a266b7360d8d0a6a5beee6')
  expect(simple.rounds.map(round => round.steps.length)).toEqual([1, 1])
  expect(simple.delivery?.mode).toBe('terminal')
  expect(normalizeWriterHistory({ ...simple, enabled: true }).rounds).toEqual(simple.rounds)
  expect(writerHistorySize(simple).characters).toBe(2778)
  for (const round of simple.rounds) expect(JSON.parse(round.steps[0]!.argumentsJson).display_stream).toBe(round.assistant)
  simple.rounds[0]!.user = '改写简单版'
  simple.delivery!.dispatch = '改写调度'
  expect(simpleTerminalWriterHistory().rounds[0]!.user).not.toBe(simple.rounds[0]!.user)
  expect(simpleTerminalWriterHistory().delivery!.dispatch).not.toBe(simple.delivery!.dispatch)
  expect(terminalWriterHistory()).toEqual(expanded)
})

it('ships six linked scenes with fewer steps, modestly longer text and lossless output records', () => {
  const config = terminalWriterHistory()
  expect(config.enabled).toBe(false)
  expect(config.rounds.map(round => round.steps.length)).toEqual([6, 4, 4, 4, 4, 4])
  expect(writerHistoryIssues(config)).toEqual([])
  expect(normalizeWriterHistory({ ...config, enabled: true }).rounds).toEqual(config.rounds)
  expect(compileWriterHistory(config).map(message => message.role)).toEqual(['user', 'assistant'])
  for (const [index, round] of config.rounds.entries()) {
    const files = terminalExampleFiles(index), chapter = files[`chapters/chapter_0${index + 1}.txt`]!
    for (let earlier = 0; earlier <= index; earlier++) {
      const path = `chapters/chapter_0${earlier + 1}.txt`
      expect(files[path]).toBe(visitingStory.chapters[earlier]!.text)
    }
    if (index > 0) for (const [path, text] of Object.entries(terminalExampleFiles(index - 1))) expect(files[path]).toBe(text)
    if (index < 5) {
      expect(files[`chapters/chapter_0${index + 2}.txt`]).toBeUndefined()
      expect(files[`state/before_0${index + 2}.tsv`]).toBeUndefined()
    }
    expect(chapter.length).toBeGreaterThanOrEqual(400)
    expect(chapter.length).toBeLessThanOrEqual(800)
    expect(JSON.parse(round.steps.at(-2)!.resultJson).output.endsWith(chapter)).toBe(true)
    expect(round.steps.slice(0, -1).every(step => step.name === 'bash')).toBe(true)
    for (const step of round.steps.slice(0, -1)) {
      const result = JSON.parse(step.resultJson)
      expect(result).toMatchObject({ exitCode: 0, truncated: false })
      expect(result.outputBytes).toBe(Buffer.byteLength(result.output))
    }
    expect(round.steps.at(-1)!.name).toBe('dispatch_chapter_example')
    const delivered = JSON.parse(round.steps.at(-1)!.argumentsJson).display_stream
    expect(delivered).toBe(round.assistant)
    expect(delivered).toContain(chapter)
  }
  expect(terminalExampleFiles(0)['state/before_02.tsv']).toBeUndefined()
  expect(terminalExampleFiles(0)['chapters/chapter_02.txt']).toBeUndefined()
  expect(terminalExampleFiles(1)['chapters/chapter_01.txt']).toBe(visitingStory.chapters[0].text)
  expect(config.rounds[1]!.steps.some(step => JSON.parse(step.argumentsJson).command?.startsWith('cd '))).toBe(false)
  config.rounds[0]!.steps[0]!.argumentsJson = '{}'
  expect(terminalWriterHistory().rounds[0]!.steps[0]!.argumentsJson).not.toBe('{}')
})

it('counts the stored history separately from archived/request text and enforces the exact terminal boundary', () => {
  const config = terminalWriterHistory(); config.enabled = true
  const size = writerHistorySize(config), preview = terminalRequestPreview(config.delivery!, writerHistoryArchive(config)!)
  expect(size.characterLimit).toBe(40_000)
  // The previous two-round example compiled to 31,240 characters. Grow rounds, not bulk.
  expect(size.characters).toBeGreaterThan(31_240)
  expect(size.characters).toBeLessThan(31_240 * 1.2)
  expect(size.bytes).toBe(Buffer.byteLength(JSON.stringify(config)))
  expect(size.archiveCharacters).toBe(writerHistoryArchive(config)!.length)
  expect(size.archiveCharacters).toBeGreaterThanOrEqual(18_000)
  expect(size.archiveCharacters).toBeLessThanOrEqual(28_000)
  expect(size.characters).not.toBe(preview.length)
  config.rounds[0]!.user += 'x'.repeat(size.characterLimit - size.characters)
  expect(writerHistorySize(config).characters).toBe(40_000)
  expect(normalizeWriterHistory(config)).toEqual(config)
  config.rounds[0]!.user += 'x'
  expect(() => normalizeWriterHistory(config)).toThrow('40,000')
  config.enabled = false
  expect(normalizeWriterHistory(config)).toEqual(config)
  config.enabled = true; config.delivery!.mode = 'text'
  expect(() => normalizeWriterHistory(config)).toThrow('20,000')
})

it('omits only an identical final echo while preserving custom replies, errors, fields and raw JSON numbers', () => {
  const config = terminalWriterHistory(), round = config.rounds[0]!, final = round.steps.at(-1)!
  const archived = terminalExamples([round])
  expect(archived).toContain('same text as the preceding tool arguments.display_stream')
  expect(archived).not.toContain(`[system@stream-output]:\n${round.assistant}`)
  expect(archived).toContain(final.argumentsJson)
  final.argumentsJson = '{"custom":' + JSON.stringify(round.assistant) + ',"number":900719925474099312345}'
  expect(terminalExamples([round], 'custom')).toContain('same text as the preceding tool arguments.custom')
  expect(terminalExamples([round], 'custom')).toContain('900719925474099312345')
  expect(terminalExamples([round])).toContain(`[system@stream-output]:\n${round.assistant}`)
  final.isError = true
  expect(terminalExamples([round], 'custom')).toContain(`[system@stream-output]:\n${round.assistant}`)
  final.isError = false; round.assistant = '用户编辑的不同结尾'
  expect(terminalExamples([round], 'custom')).toContain('[system@stream-output]:\n用户编辑的不同结尾')
  final.argumentsJson = '{unfinished'
  expect(terminalExamples([round], 'custom')).toContain('{unfinished')
})
