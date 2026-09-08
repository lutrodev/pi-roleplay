/** Built-in commands are separate from user-invocable Skills and ordinary message text. */
export function composerCommand(text: string): { name: 'compact'; argument: string } | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/u.exec(text.trim())
  return match ? { name: 'compact', argument: match[1]?.trim() ?? '' } : null
}
