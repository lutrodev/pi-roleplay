import { storyReferenceIds } from '../../../../packages/rp-core/src/interaction/references.ts'

const reference = '@story:[a-f0-9]{8}-[a-f0-9-]{27}'

/** Keep the existing wire protocol out of the writing surface. Preserve ordinary whitespace. */
export function referenceText(value: string) {
  const ids = storyReferenceIds(value)
  if (!ids.length) return { text: value, ids }
  const trailer = new RegExp(`\\n\\n${reference}(?: ${reference})*$`, 'iu')
  const body = value.replace(trailer, '')
  return { text: body.replace(new RegExp(`(?<!\\S)${reference}(?=\\s|$)`, 'giu'), ''), ids }
}

export function withReferences(text: string, ids: readonly string[]) {
  const references = [...new Set(ids)]
  return references.length ? `${text}\n\n${references.map(id => `@story:${id}`).join(' ')}` : text
}

export interface CompletionSpan { kind: 'commands' | 'references'; start: number; end: number; query: string }
export function completionAt(text: string, cursor: number): CompletionSpan | null {
  const before = text.slice(0, cursor)
  const command = /^\/([^\s/]*)$/u.exec(before)
  if (command) return { kind: 'commands', start: 0, end: cursor, query: command[1]! }
  const mention = /(?:^|\s)@([^@\n]*)$/u.exec(before)
  if (mention) return { kind: 'references', start: cursor - mention[1]!.length - 1, end: cursor, query: mention[1]! }
  return null
}
