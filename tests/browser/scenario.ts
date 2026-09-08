/** Scenario switches belong to the current input, never to replayed conversation history. */
export function browserScenario(messages: { role: string; content?: unknown }[]) {
  const texts = messages.filter(message => message.role === 'user').map(({ content: value }) => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part && typeof part === 'object' && 'text' in part ? String(part.text) : '').join('\n') : '')
  const text = texts.findLast(value => value.includes('<section name="当前输入">')) ?? ''
  const input = text.match(/<section name="当前输入">([\s\S]*?)<\/section>/u)?.[1] ?? ''
  const stateRevision = () => {
    const contract = JSON.parse(text.match(/<commit_content>([\s\S]*?)<\/commit_content>/u)?.[1] ?? '{}')
    const revision = contract.state_commit_contract?.namespaces?.find((item: { namespace: string }) => item.namespace === 'story')?.expectedRevision
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('State fixture requires the current story revision')
    return revision as number
  }
  return { has: (marker: string) => input.includes(marker), stateRevision }
}
