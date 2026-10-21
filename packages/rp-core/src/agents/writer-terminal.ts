import { writerDeliveryTemplate, type WriterDelivery } from './writer-delivery.ts'
import type { WriterHistoryRound } from './writer-history.ts'

export const TERMINAL_ARCHIVE_ROOT = '/workspace/archive'
export const terminalShellPrompt = (directory = TERMINAL_ARCHIVE_ROOT) => `writer@linux:${directory}$`

/** The caller classifies messages from story facts, never from markers in untrusted text. */
export function terminalInput(text: string, filename: string): string {
  return `${terminalShellPrompt()} cat ${filename.replace(/\.txt$/, '_preview.txt')}\n${text}\n${terminalShellPrompt()} cat ${filename}`
}

function finalExampleOutput(round: WriterHistoryRound, fieldName: string): string {
  const last = round.steps.at(-1)
  try {
    // Inspect only the string field; retain the original JSON source (including large numbers) below.
    if (last && !last.isError && JSON.parse(last.argumentsJson)?.[fieldName] === round.assistant)
      return `[system@stream-output]: same text as the preceding tool arguments.${fieldName}`
  } catch { /* Incomplete editor drafts retain the literal assistant text. */ }
  return `[system@stream-output]:\n${round.assistant}`
}

export function terminalExamples(rounds: WriterHistoryRound[], fieldName = 'display_stream'): string {
  return rounds.map((round, index) => [
    `[example round ${index + 1}]`,
    terminalInput(round.user, `example_${String(index + 1).padStart(2, '0')}.txt`),
    ...round.steps.map(step => `\n[example tool: ${step.name}]\narguments = ${step.argumentsJson}\nresult = ${step.resultJson}\nisError = ${step.isError}`),
    finalExampleOutput(round, fieldName),
  ].join('\n\n')).join('\n\n---\n\n')
}

/** Both the editor preview and the runtime use this exact archive layout. */
export function terminalArchive(system: string, examples: string, context: string): string {
  return [
    `【${TERMINAL_ARCHIVE_ROOT}/ 本地工作目录文件与历史章节归档】`,
    `${terminalShellPrompt()} cat writer_rules.txt\n${system}`,
    `<example_archive>\n${examples}\n</example_archive>`,
    `<current_archive>\n${context}\n</current_archive>`,
  ].join('\n\n---\n\n')
}

export function terminalRequestPreview(delivery: WriterDelivery, examples: string) {
  const render = (text: string) => writerDeliveryTemplate(text, delivery)
  return JSON.stringify({
    messages: [{ role: 'system', content: render(delivery.system) }, { role: 'user', content: render(delivery.dispatch) },
      { role: 'assistant', content: render(delivery.acknowledgement) }, { role: 'user', content: render(delivery.invocation) }],
    tools: [{ type: 'function', function: { name: delivery.toolName,
      description: `${render(delivery.toolDescription)}\n\n${terminalArchive('〔本轮 Writer 系统规则〕', examples,
        terminalInput('〔真实历史中的用户输入〕', 'history_01.txt') + '\n\n[system@stream-output]:\n〔已提交剧情或讨论，保留类型〕\n\n'
        + terminalInput('〔本轮真实输入〕', 'chapter_01.txt') + '\n\n〔已选角色、世界、风格、变量、附件与本轮任务〕')}`,
      parameters: { type: 'object', properties: { [delivery.fieldName]: { type: 'string', minLength: 1, maxLength: 200_000, description: render(delivery.fieldDescription) } },
        required: [delivery.fieldName], additionalProperties: false },
    } }], tool_choice: 'auto',
  }, null, 2)
}
