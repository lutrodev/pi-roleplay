/** Explicit mentions only; email addresses and quoted story prose do not recursively expand. */
export function storyReferenceIds(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|\s)@story:([a-f0-9]{8}-[a-f0-9-]{27})(?=\s|$)/giu)].map(match => match[1]!.toLowerCase()))]
}
export function fileMention(path: string, directory = false): string | null {
  if (!path || /[\u0000-\u001f\u007f"\\]/u.test(path) || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '')) return null
  return `@"${path}${directory && !path.endsWith('/') ? '/' : ''}"`
}
