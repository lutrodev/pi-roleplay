import type { JsonObject, StoryEvent, StoryMessage, StorySnapshot } from '../types.ts'

export interface ModelHistoryEntry {
  id: string
  seq: number
  runId: string | null
  ownerMessageId: string | null
  kind: 'input' | 'context' | 'runtime' | 'assistant' | 'toolResult'
  message: JsonObject
  sourceMessageIds?: string[]
}

/** The model surface and the reading surface share the story journal, but have different projections. */
export function projectModelHistory(events: readonly StoryEvent[], story: StorySnapshot, checkpoint = story.checkpoint, currentRunId?: string) {
  const entries: ModelHistoryEntry[] = []
  const visible = new Map(story.messages.map(message => [message.id, message]))
  const originals = new Map<string, StoryMessage>()
  const edits = new Map<string, number>()
  const removedRuns = new Set<string>(), removedOutputs = new Set<string>(), deletedAfter = new Map<string, number>()
  const nativeRuns = new Set<string>()
  const inheritedOwners = new Set<string>()
  const inherited: { entry: ModelHistoryEntry; revision: number }[] = []
  const contexts = new Map<string, Extract<StoryEvent, { type: 'context.built' | 'context.compacted' }>[]>()
  const messagePositions = new Map<string, number>()
  const firstSdkInputs = new Map<string, number>()
  const covered = new Set(checkpoint?.sourceMessageIds ?? [])
  const coveredRuns = new Set(story.messages.filter(message => covered.has(message.id)).flatMap(message => message.runId ? [message.runId] : []))
  for (const event of events) {
    if (event.type === 'message.added' || event.type === 'turn.committed') {
      originals.set(event.data.message.id, event.data.message)
      messagePositions.set(event.data.message.id, event.seq)
    }
    if (event.type === 'message.edited') edits.set(event.data.messageId, event.seq)
    if (event.type === 'messages.removed') for (const id of event.data.messageIds) {
      const owner = originals.get(id)
      if (!owner?.runId) continue
      if (event.data.reason === 'regenerate' || !story.messages.some(message => message.runId === owner.runId && message.role === 'user')) removedRuns.add(owner.runId)
      if (!story.messages.some(message => message.runId === owner.runId && message.role === 'assistant' && message.kind !== 'draft')) removedOutputs.add(owner.runId)
      deletedAfter.set(owner.runId, Math.min(deletedAfter.get(owner.runId) ?? Infinity, messagePositions.get(id) ?? event.seq))
    }
    if (event.type === 'model.message' && (event.data.role === 'assistant' || event.data.role === 'toolResult')) {
      nativeRuns.add(event.data.runId)
    }
    if (event.type === 'model.message' && event.data.role === 'user' && !firstSdkInputs.has(event.data.runId)) firstSdkInputs.set(event.data.runId, event.seq)
    if (event.type === 'history.inherited') for (const entry of event.data.entries) {
      inherited.push({ entry, revision: event.seq })
      if (entry.ownerMessageId) inheritedOwners.add(entry.ownerMessageId)
      if (entry.runId) nativeRuns.add(entry.runId)
    }
    if (event.type === 'context.built' || event.type === 'context.compacted') {
      contexts.set(event.data.runId, [...contexts.get(event.data.runId) ?? [], event])
    }
  }
  const activeRuns = new Set(story.messages.flatMap(message => message.runId ? [message.runId] : []))
  const outputRuns = new Set(story.messages.filter(message => message.role === 'assistant' && message.kind !== 'draft').flatMap(message => message.runId ? [message.runId] : []))
  const missingRuns = new Set<string>()
  for (const { entry, revision } of inherited) {
    if (entry.ownerMessageId && covered.has(entry.ownerMessageId) || entry.runId && (coveredRuns.has(entry.runId) || removedRuns.has(entry.runId))) continue
    const owner = entry.ownerMessageId ? visible.get(entry.ownerMessageId) : undefined
    if (entry.kind === 'input' && !owner || entry.runId && removedOutputs.has(entry.runId) && entry.kind !== 'input' && entry.kind !== 'context') continue
    if (entry.runId && !activeRuns.has(entry.runId)) continue
    if (entry.kind !== 'input' && entry.kind !== 'context') {
      if (entry.runId && entry.runId !== currentRunId && !outputRuns.has(entry.runId)) continue
      if (entry.ownerMessageId && originals.has(entry.ownerMessageId) && !owner) continue
      if (entry.runId && !owner && entry.seq >= (deletedAfter.get(entry.runId) ?? Infinity)) continue
    }
    if (entry.kind === 'context' && entry.sourceMessageIds?.some(id => !visible.has(id) || covered.has(id) || (edits.get(id) ?? 0) > revision)) continue
    const copy = structuredClone(entry)
    if (owner && (edits.get(owner.id) ?? 0) > revision) {
      if (copy.kind === 'assistant') copy.message = editAssistant(copy.message, owner.text)
      if (copy.kind === 'input') copy.message.content = [{ type: 'text', text: owner.text }, ...owner.attachmentIds.map(fileId => ({ type: 'attachment_reference', fileId }))]
    }
    entries.push(copy)
  }
  for (const event of events) {
    if (event.type === 'message.added' || event.type === 'turn.committed') {
      const source = event.data.message, message = visible.get(source.id)
      if (!message || inheritedOwners.has(message.id) || covered.has(message.id) || message.kind === 'draft') continue
      if (message.role === 'assistant' && message.runId && nativeRuns.has(message.runId)) continue
      if (message.role === 'assistant' && message.runId && message.kind !== 'opening') {
        missingRuns.add(message.runId)
        continue
      }
      if (message.kind === 'tool') continue
      entries.push({ id: `message:${message.id}`, seq: event.seq, runId: message.runId, ownerMessageId: message.id,
        kind: message.role === 'user' ? 'input' : 'assistant', message: {
          role: message.role, content: [{ type: 'text', text: message.text }, ...message.attachmentIds.map(fileId => ({ type: 'attachment_reference', fileId }))],
          timestamp: Date.parse(message.createdAt),
        } })
    } else if (event.type === 'model.message') {
      const { runId, role, ownerMessageId } = event.data
      if (!activeRuns.has(runId) || removedRuns.has(runId) || removedOutputs.has(runId) || coveredRuns.has(runId)) continue
      if (runId !== currentRunId && !outputRuns.has(runId)) continue
      if (originals.has(ownerMessageId) && !visible.has(ownerMessageId)) continue
      if (!originals.has(ownerMessageId) && event.seq >= (deletedAfter.get(runId) ?? Infinity)) continue
      if (role !== 'assistant' && role !== 'toolResult' && role !== 'user') continue
      const raw = event.data.message
      // Ordinary user inputs and RP snapshots have their own durable source events.
      // Before native history, the first SDK user combined the entire prompt into one string.
      if (role === 'user' && raw.rpSource !== 'runtime' && (raw.rpSource !== undefined || firstSdkInputs.get(runId) === event.seq)) continue
      if (role === 'assistant' && (raw.stopReason === 'error' || raw.stopReason === 'aborted' || !Array.isArray(raw.content) || !raw.content.length)) continue
      let message = structuredClone(raw)
      const owner = visible.get(ownerMessageId)
      if (role === 'assistant' && owner && edits.has(ownerMessageId)) message = editAssistant(message, owner.text)
      entries.push({ id: `model:${event.seq}`, seq: event.seq, runId, ownerMessageId,
        kind: role === 'user' ? 'runtime' : role, message })
    }
  }
  for (const [runId, candidates] of contexts) {
    if (!activeRuns.has(runId) || removedRuns.has(runId) || coveredRuns.has(runId)) continue
    const input = story.messages.findLast(message => message.runId === runId && message.role === 'user')
    if (!input) continue
    // A snapshot that quotes an edited/deleted/compacted conversation is no longer a valid surface node.
    // Its immutable source remains available in the request log.
    const resolved = candidates.map(event => ({ event, dependencies: event.data.sourceMessageIds ?? [...originals.values()].filter(message =>
      message.kind !== 'tool' && message.kind !== 'draft' && (messagePositions.get(message.id) ?? Infinity) < event.seq).map(message => message.id) }))
      .findLast(({ event, dependencies }) => !dependencies.some(id => !visible.has(id) || covered.has(id) || (edits.get(id) ?? 0) > event.seq))
    if (!resolved) continue
    const { event, dependencies } = resolved
    if (event.data.runtimePrompt) entries.push({ id: `runtime:${runId}`, seq: event.seq, runId, ownerMessageId: input.id, kind: 'context', sourceMessageIds: dependencies,
      message: { role: 'user', content: [{ type: 'text', text: event.data.runtimePrompt }], timestamp: Date.parse(event.createdAt) } })
    entries.push({ id: `context:${runId}`, seq: event.seq, runId, ownerMessageId: input.id, kind: 'context',
      sourceMessageIds: dependencies,
      message: { role: 'user', content: [{ type: 'text', text: event.data.parentPrompt }], timestamp: Date.parse(event.createdAt) } })
  }
  return { entries: entries.sort((a, b) => a.seq - b.seq), missingRuns: [...missingRuns] }
}

function editAssistant(message: JsonObject, text: string): JsonObject {
  const content = Array.isArray(message.content) ? message.content : []
  let hasReply = false
  const updated = content.map(part => {
    if (!part || typeof part !== 'object' || Array.isArray(part) || part.type !== 'toolCall') return part
    if (part.name !== 'rp_reply' && part.name !== 'rp_commit_turn') return part
    const args = part.arguments && typeof part.arguments === 'object' && !Array.isArray(part.arguments) ? part.arguments : {}
    if (part.name === 'rp_commit_turn' && !('narrative' in args)) return part
    hasReply = true
    const updatedArgs: JsonObject = part.name === 'rp_reply' ? { text } : { ...args, narrative: text }
    return { ...part, arguments: updatedArgs }
  })
  return { ...message, content: hasReply ? updated : [{ type: 'text', text }, ...updated.filter(part =>
    part && typeof part === 'object' && !Array.isArray(part) && part.type === 'toolCall')] }
}
