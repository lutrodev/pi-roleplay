import type { WriterHistoryConfig, WriterHistoryStep } from './writer-history.ts'
import { terminalWriterDelivery } from './writer-delivery.ts'
import { TERMINAL_ARCHIVE_ROOT, terminalShellPrompt } from './writer-terminal.ts'
import { visitingReferenceFiles, visitingStory } from './writer-terminal-story.ts'

export const TERMINAL_EXAMPLE_DIRECTORY = `${TERMINAL_ARCHIVE_ROOT}/visiting-days`
const bytes = (text: string) => new TextEncoder().encode(text).length
const lines = (text: string) => text.replace(/\n$/, '').split('\n')

/** The second chapter snapshot adds files without rewriting chapter 1. */
export function terminalExampleFiles(round: 0 | 1): Record<string, string> {
  const files: Record<string, string> = { ...visitingReferenceFiles,
    'requests/chapter_01_preview.txt': visitingStory.firstInput + '\n', 'chapters/chapter_01.txt': visitingStory.firstChapter }
  if (round === 0) delete files['state/before_02.tsv']
  else Object.assign(files, { 'requests/chapter_02_preview.txt': visitingStory.secondInput + '\n', 'chapters/chapter_02.txt': visitingStory.secondChapter })
  return files
}

function chapterStats(path: string, text: string): string {
  const size = bytes(text), count = text.split('\n').length - 1, width = String(size).length
  return `${path}: text/plain; charset=utf-8\n${String(count).padStart(width)} ${size} ${path}\n`
}

/** Authored records, not a shell interpreter. The Linux acceptance suite checks every command output. */
export function terminalWriterHistory(): WriterHistoryConfig {
  const delivery = terminalWriterDelivery()
  return { enabled: false, delivery, rounds: ([0, 1] as const).map(round => {
    const files = terminalExampleFiles(round), chapter = `chapters/chapter_0${round + 1}.txt`
    const read = (path: string) => files[path]!
    const commands: [command: string, output: string][] = round === 0 ? [
      [`cd ${TERMINAL_EXAMPLE_DIRECTORY}`, ''],
      ['pwd', TERMINAL_EXAMPLE_DIRECTORY + '\n'],
      ['ls -1F', 'README.md\nchapters/\ncharacters/\nconfig/\nrequests/\nstate/\n'],
      ['find . -maxdepth 2 -type f | sort', Object.keys(files).sort().map(path => `./${path}\n`).join('')],
      ['cat README.md config/writer_rules.txt', read('README.md') + read('config/writer_rules.txt')],
      ["sed -n '1,100p' characters/main.md", read('characters/main.md')],
      ['cat config/style.md', read('config/style.md')],
      ['cat state/before_01.tsv', read('state/before_01.tsv')],
      ['cat requests/chapter_01_preview.txt', read('requests/chapter_01_preview.txt')],
      [`file --mime ${chapter} && wc -l -c ${chapter}`, chapterStats(chapter, read(chapter))],
      [`cat ${chapter}`, read(chapter)],
    ] : [
      ['pwd', TERMINAL_EXAMPLE_DIRECTORY + '\n'],
      ['ls -1 chapters/', 'chapter_01.txt\nchapter_02.txt\n'],
      ['tail -n 9 chapters/chapter_01.txt', lines(read('chapters/chapter_01.txt')).slice(-9).join('\n') + '\n'],
      ['cat state/before_02.tsv', read('state/before_02.tsv')],
      ["grep -n -E '台灯|标签|杯垫' chapters/chapter_01.txt", lines(read('chapters/chapter_01.txt')).flatMap((line, index) => /台灯|标签|杯垫/.test(line) ? [`${index + 1}:${line}\n`] : []).join('')],
      ['cat requests/chapter_02_preview.txt', read('requests/chapter_02_preview.txt')],
      ["sed -n '4,8p' config/style.md", lines(read('config/style.md')).slice(3, 8).join('\n') + '\n'],
      [`file --mime ${chapter} && wc -l -c ${chapter}`, chapterStats(chapter, read(chapter))],
      [`cat ${chapter}`, read(chapter)],
    ]
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
    return { user: round === 0 ? visitingStory.firstInput : visitingStory.secondInput, steps, assistant: display }
  }) }
}
