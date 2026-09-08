import type { StoryEvent, StoryMessage } from '../types.ts'

export interface ConversationAttempt { runId: string; removedAt?: number }
export interface ConversationRound {
  id: string; cursor: number; round: number; attempts: ConversationAttempt[]
  state: 'active' | 'input-only' | 'deleted'
  inputs: { message: StoryMessage; seq: number; editedAt?: number }[]
}

/** Logical rounds come from real message ownership, never provider/preset history messages. */
export function projectConversationRounds(events: readonly StoryEvent[], ownRunIds: ReadonlySet<string>) {
  const groups: ConversationRound[] = [], owners = new Map<string, ConversationRound>()
  const messages = new Map<string, { message: StoryMessage; seq: number; editedAt?: number }>(), active = new Set<string>()
  let revision = 0, legacyReplacement: { previousRunId: string } | undefined
  const ensure = (runId: string, seq: number) => {
    if (!ownRunIds.has(runId)) return undefined // Forks do not invent executions of their copied messages.
    let group = owners.get(runId)
    if (!group) {
      group = { id: runId, cursor: seq, round: 0, state: 'active', attempts: [{ runId }], inputs: [] }
      groups.push(group); owners.set(runId, group)
    }
    return group
  }
  const replace = (previousRunId: string, runId: string) => {
    const group = owners.get(previousRunId)
    if (!group || !ownRunIds.has(runId) || owners.has(runId)) return
    group.attempts.push({ runId }); owners.set(runId, group)
  }
  const numberActive = () => {
    let number = 0
    for (const group of groups) if (group.inputs.some(input => active.has(input.message.id))) group.round = ++number
  }
  for (const event of events) {
    if (event.type === 'message.added' || event.type === 'turn.committed') {
      const message = event.data.message
      // Older journals recorded removal and copied inputs atomically, before queued.
      // Recover that exact adjacency; no text matching or request-count heuristics.
      if (legacyReplacement && event.type === 'message.added' && message.role === 'user' && message.runId) replace(legacyReplacement.previousRunId, message.runId)
      legacyReplacement = undefined
      const input = { message: structuredClone(message), seq: event.seq }
      messages.set(message.id, input); active.add(message.id)
      if (message.runId) {
        const group = ensure(message.runId, event.seq)
        if (group && message.role === 'user') group.inputs.push(input)
      }
    } else if (event.type === 'messages.removed') {
      revision = event.seq
      numberActive() // Deleted rounds retain the number they had when removed.
      const previous = new Set<string>()
      for (const id of event.data.messageIds) {
        const message = messages.get(id)?.message
        if (!message?.runId || !active.has(id)) { active.delete(id); continue }
        previous.add(message.runId)
        if (event.data.reason === 'delete') {
          const attempt = owners.get(message.runId)?.attempts.find(attempt => attempt.runId === message.runId)
          if (attempt) attempt.removedAt = event.seq
        }
        active.delete(id)
      }
      if (event.data.reason === 'regenerate') {
        if (event.data.replacement) replace(event.data.replacement.previousRunId, event.data.replacement.runId)
        else if (previous.size === 1) legacyReplacement = { previousRunId: [...previous][0]! }
      }
    } else if (event.type === 'message.edited') {
      revision = event.seq
      const input = messages.get(event.data.messageId)
      if (input && active.has(input.message.id)) { input.message.text = event.data.text; input.editedAt = event.seq }
    } else if (event.type === 'run.status' && event.data.status === 'queued') {
      ensure(event.data.runId, event.seq)
      legacyReplacement = undefined
    }
  }
  numberActive()
  for (const group of groups) {
    group.inputs = group.inputs.filter(input => active.has(input.message.id))
    group.state = !group.inputs.length ? 'deleted' : group.attempts.at(-1)!.removedAt ? 'input-only' : 'active'
  }
  return { rounds: groups, revision }
}
