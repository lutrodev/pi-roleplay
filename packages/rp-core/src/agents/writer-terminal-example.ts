import type { WriterHistoryConfig, WriterHistoryStep } from './writer-history.ts'
import { terminalWriterDelivery } from './writer-delivery.ts'
import { TERMINAL_ARCHIVE_ROOT, terminalShellPrompt } from './writer-terminal.ts'
import { visitingReferenceFiles, visitingStory } from './writer-terminal-story.ts'

export const TERMINAL_EXAMPLE_DIRECTORY = `${TERMINAL_ARCHIVE_ROOT}/visiting-days`
const bytes = (text: string) => new TextEncoder().encode(text).length
const lines = (text: string) => text.replace(/\n$/, '').split('\n')
const chapterNumber = (index: number) => String(index + 1).padStart(2, '0')

/** Each scene adds only its own files; previous scenes remain byte-identical and future scenes stay absent. */
export function terminalExampleFiles(round: number): Record<string, string> {
  if (!Number.isInteger(round) || round < 0 || round >= visitingStory.chapters.length) throw new RangeError('Invalid terminal example round')
  const files = Object.fromEntries(Object.entries(visitingReferenceFiles).filter(([path]) => !path.startsWith('state/')))
  for (let index = 0; index <= round; index++) {
    const number = chapterNumber(index), scene = visitingStory.chapters[index]!
    files[`state/before_${number}.tsv`] = visitingReferenceFiles[`state/before_${number}.tsv`]!
    files[`requests/chapter_${number}_preview.txt`] = scene.input + '\n'
    files[`chapters/chapter_${number}.txt`] = scene.text
  }
  return files
}

function chapterStats(path: string, text: string): string {
  const size = bytes(text), count = text.split('\n').length - 1, width = String(size).length
  return `${path}: text/plain; charset=utf-8\n${String(count).padStart(width)} ${size} ${path}\n`
}

/** Authored records, not a shell interpreter. The Linux acceptance suite checks every command output. */
export function terminalWriterHistory(): WriterHistoryConfig {
  const delivery = terminalWriterDelivery()
  return { enabled: false, delivery, rounds: visitingStory.chapters.map((scene, round) => {
    const files = terminalExampleFiles(round), number = chapterNumber(round), chapter = `chapters/chapter_${number}.txt`
    const read = (path: string) => files[path]!
    const state = `state/before_${number}.tsv`, input = `requests/chapter_${number}_preview.txt`
    const previous = `chapters/chapter_${chapterNumber(round - 1)}.txt`
    const context: [command: string, output: string] = [`cat ${state} ${input}`, read(state) + read(input)]
    const fullChapter: [command: string, output: string] = round === 0
      ? [`file --mime ${chapter} && wc -l -c ${chapter} && cat ${chapter}`, chapterStats(chapter, read(chapter)) + read(chapter)]
      : [`cat ${chapter}`, read(chapter)]
    const continuity: [command: string, output: string] = round === 4
      ? ["grep -n -E '杯子|九点|标签' chapters/chapter_04.txt", lines(read(previous)).flatMap((line, index) => /杯子|九点|标签/.test(line) ? [`${index + 1}:${line}\n`] : []).join('')]
      : [`tail -n 3 ${previous}`, round ? lines(read(previous)).slice(-3).join('\n') + '\n' : '']
    const commands: [command: string, output: string][] = round === 0 ? [
      [`cd ${TERMINAL_EXAMPLE_DIRECTORY} && pwd`, TERMINAL_EXAMPLE_DIRECTORY + '\n'],
      ['ls -1F', 'README.md\nchapters/\ncharacters/\nconfig/\nrequests/\nstate/\n'],
      ['cat README.md config/writer_rules.txt characters/main.md config/style.md',
        ['README.md', 'config/writer_rules.txt', 'characters/main.md', 'config/style.md'].map(read).join('')],
      context,
      fullChapter,
    ] : [continuity, context, fullChapter]
    const steps: WriterHistoryStep[] = commands.map(([command, output], index) => ({ name: 'bash',
      argumentsJson: JSON.stringify({ command }, null, 2),
      resultJson: JSON.stringify({ output, exitCode: 0, truncated: false, shellState: round === 0 && index === 0 ? 'new' : 'retained', outputBytes: bytes(output) }, null, 2),
      isError: false,
    }))
    const display = commands.map(([command, output], index) => {
      const cwd = round === 0 && index === 0 ? TERMINAL_ARCHIVE_ROOT : TERMINAL_EXAMPLE_DIRECTORY
      return `${terminalShellPrompt(cwd)} ${command}\n${output}`
    }).join('')
    steps.push({ name: 'dispatch_chapter_example', argumentsJson: JSON.stringify({ [delivery.fieldName]: display }, null, 2),
      resultJson: JSON.stringify({ channel: delivery.fieldName, chapter, characters: display.length }, null, 2), isError: false })
    return { user: scene.input, steps, assistant: display }
  }) }
}
