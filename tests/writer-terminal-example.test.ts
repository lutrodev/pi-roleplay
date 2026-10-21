import { expect, it } from 'vitest'
import { terminalWriterHistory } from '../packages/rp-core/src/agents/writer-history-example.ts'
import { terminalExampleFiles } from '../packages/rp-core/src/agents/writer-terminal-example.ts'
import { visitingStory } from '../packages/rp-core/src/agents/writer-terminal-story.ts'
import { compileWriterHistory, normalizeWriterHistory, writerHistoryArchive, writerHistoryIssues, writerHistorySize } from '../packages/rp-core/src/agents/writer-history.ts'
import { terminalExamples, terminalRequestPreview } from '../packages/rp-core/src/agents/writer-terminal.ts'

it('ships two complete linked adult stories with 12/10 editable steps and lossless output records', () => {
  const config = terminalWriterHistory()
  expect(config.enabled).toBe(false)
  expect(config.rounds.map(round => round.steps.length)).toEqual([12, 10])
  expect(writerHistoryIssues(config)).toEqual([])
  expect(normalizeWriterHistory({ ...config, enabled: true }).rounds).toEqual(config.rounds)
  expect(compileWriterHistory(config).map(message => message.role)).toEqual(['user', 'assistant'])
  for (const [index, round] of config.rounds.entries()) {
    const files = terminalExampleFiles(index as 0 | 1), chapter = files[`chapters/chapter_0${index + 1}.txt`]!
    expect(chapter.length).toBeGreaterThanOrEqual(1000)
    expect(chapter.length).toBeLessThanOrEqual(1400)
    expect(JSON.parse(round.steps.at(-2)!.resultJson).output).toBe(chapter)
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
  expect(terminalExampleFiles(0)).not.toHaveProperty('state/before_02.tsv')
  expect(terminalExampleFiles(0)).not.toHaveProperty('chapters/chapter_02.txt')
  expect(terminalExampleFiles(1)['chapters/chapter_01.txt']).toBe(visitingStory.firstChapter)
  expect(config.rounds[1]!.steps.some(step => JSON.parse(step.argumentsJson).command?.startsWith('cd '))).toBe(false)
  config.rounds[0]!.steps[0]!.argumentsJson = '{}'
  expect(terminalWriterHistory().rounds[0]!.steps[0]!.argumentsJson).not.toBe('{}')
})

it('counts the stored history separately from archived/request text and enforces the exact terminal boundary', () => {
  const config = terminalWriterHistory(); config.enabled = true
  const size = writerHistorySize(config), preview = terminalRequestPreview(config.delivery!, writerHistoryArchive(config)!)
  expect(size.characterLimit).toBe(40_000)
  expect(size.characters).toBeGreaterThan(20_000)
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
