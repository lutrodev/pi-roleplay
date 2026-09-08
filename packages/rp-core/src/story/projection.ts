import { RpError } from '../errors.ts'
import { decodeStoredReplyOptions, REPLY_OPTIONS_EXTENSION_NAMESPACE } from '../interaction/reply-options.js'
import type { StateUpdate, StoryEvent, StoryMessage, StorySnapshot, StoryState, ToolRecord, UserQuestion } from '../types.ts'

function applyUpdates(state: StoryState, updates: readonly StateUpdate[]) {
  for (const update of updates) {
    if (update.snapshot === null) delete state.namespaces[update.namespace]
    else state.namespaces[update.namespace] = structuredClone(update.snapshot)
  }
}

/** Rebuild the complete visible story and state from the immutable event journal. */
export function projectStory(events: readonly StoryEvent[]): StorySnapshot {
  const first = events[0]
  if (first?.type !== 'story.created') throw new RpError('STORY_CORRUPT', '故事缺少创建记录。', 500)
  const messages = new Map<string, StoryMessage>()
  const active = new Set<string>()
  const removedRuns = new Set<string>()
  const lastEdited = new Map<string, number>()
  const tools = new Map<string, ToolRecord>()
  const questions = new Map<string, UserQuestion>()
  const snapshot: StorySnapshot = {
    id: first.storyId,
    ...(first.data.forkedFrom ? { forkedFrom: structuredClone(first.data.forkedFrom) } : {}),
    title: first.data.title,
    archived: false,
    revision: first.seq,
    profile: structuredClone(first.data.profile),
    messages: [],
    conversationRunId: null,
    state: structuredClone(first.data.bootstrap),
    summaries: [],
    tools: [],
    questions: [],
    replyOptions: {},
    maintenance: {},
    summaryCandidate: null,
    checkpoint: null,
    createdAt: first.createdAt,
    updatedAt: first.createdAt,
  }
  let previousSeq = -1
  let bootstrap = first.data.bootstrap
  for (const event of events) {
    if (event.storyId !== snapshot.id || event.seq <= previousSeq) throw new RpError('STORY_CORRUPT', '故事记录的顺序不正确。', 500)
    previousSeq = event.seq
    snapshot.revision = event.seq
    snapshot.updatedAt = event.createdAt
    switch (event.type) {
      case 'story.renamed': snapshot.title = event.data.title; break
      case 'story.archived': snapshot.archived = event.data.archived; break
      case 'profile.changed':
        snapshot.profile = structuredClone(event.data.profile)
        if (event.data.bootstrap) bootstrap = event.data.bootstrap
        break
      case 'message.added':
      case 'turn.committed': {
        const incoming = event.data.message
        messages.set(incoming.id, structuredClone(incoming))
        active.add(incoming.id)
        if (event.type === 'turn.committed') {
          const options = decodeStoredReplyOptions(event.data.extensions[REPLY_OPTIONS_EXTENSION_NAMESPACE])
          if (options) snapshot.replyOptions[incoming.id] = options.options
          const diagnostic = event.data.diagnostics?.find(item => item.source === REPLY_OPTIONS_EXTENSION_NAMESPACE)
          delete snapshot.maintenance['reply-options']
          if (diagnostic) snapshot.maintenance['reply-options'] = { id: event.data.commitId, kind: 'reply-options', status: 'failed',
            runId: event.data.runId, messageId: incoming.id, code: diagnostic.code, message: diagnostic.message,
          }
        }
        break
      }
      case 'message.edited': {
        const message = messages.get(event.data.messageId)
        if (!message || !active.has(message.id)) throw new RpError('STORY_CORRUPT', '编辑记录没有对应的消息。', 500)
        message.text = event.data.text
        lastEdited.set(message.id, event.seq)
        delete snapshot.replyOptions[message.id]
        break
      }
      case 'messages.removed':
        for (const id of event.data.messageIds) {
          const runId = messages.get(id)?.runId
          if (active.has(id) && runId) removedRuns.add(runId)
          active.delete(id)
        }
        break
      case 'message.feedback': {
        const message = messages.get(event.data.messageId)
        if (message && active.has(message.id)) message.feedback = { rating: event.data.rating, comment: event.data.comment }
        break
      }
      case 'tool.started': tools.set(event.data.callId, structuredClone(event.data)); break
      case 'tool.updated': {
        const tool = tools.get(event.data.callId)
        if (tool) tool.output = (tool.output ?? '') + event.data.output
        break
      }
      case 'tool.finished': {
        const tool = tools.get(event.data.callId)
        if (tool) { tool.result = structuredClone(event.data.result); tool.status = event.data.failed ? 'failed' : 'completed' }
        break
      }
      case 'question.asked': questions.set(event.data.id, structuredClone(event.data)); break
      case 'question.answered': {
        const question = questions.get(event.data.questionId)
        if (question) { question.status = 'answered'; question.answers = structuredClone(event.data.answers) }
        break
      }
      case 'question.cancelled': {
        const question = questions.get(event.data.questionId)
        if (question) question.status = 'cancelled'
        break
      }
      case 'run.status':
        if (['cancelled', 'failed', 'interrupted'].includes(event.data.status)) {
          for (const question of questions.values()) if (question.runId === event.data.runId && question.status === 'pending') question.status = 'cancelled'
          for (const tool of tools.values()) if (tool.runId === event.data.runId && tool.status === 'running') tool.status = 'interrupted'
        }
        break
      // Replay already saved events; new suggestions are owned by turn.committed.
      case 'reply-options.ready': snapshot.replyOptions[event.data.messageId] = [...event.data.options]; break
      case 'summary.candidate': snapshot.summaryCandidate = structuredClone(event.data); break
      case 'maintenance.status':
        snapshot.maintenance[event.data.kind] = structuredClone(event.data)
        if (event.data.kind === 'summary' && (event.data.status !== 'ready' || snapshot.summaryCandidate?.id !== event.data.id)) snapshot.summaryCandidate = null
        break
      default: break
    }
  }

  snapshot.state = structuredClone(bootstrap)
  for (const event of events) {
    if (event.type === 'turn.committed' && active.has(event.data.message.id)) {
      applyUpdates(snapshot.state, event.data.stateUpdates)
      snapshot.summaries.push({ messageId: event.data.message.id, text: event.data.summary })
    } else if (event.type === 'state.configured' && active.has(event.data.ownerMessageId)) {
      applyUpdates(snapshot.state, [event.data.update])
    } else if (event.type === 'summary.created' && event.data.sourceMessageIds.every(id => active.has(id) && (lastEdited.get(id) ?? 0) <= event.seq)) {
      snapshot.checkpoint = structuredClone(event.data)
    }
  }
  snapshot.messages = [...messages.values()].filter(message => active.has(message.id))
  const tailRunId = snapshot.messages.findLast(message => message.kind !== 'tool')?.runId
  snapshot.conversationRunId = tailRunId && !removedRuns.has(tailRunId) ? tailRunId : null
  const activeRuns = new Set(snapshot.messages.flatMap(message => message.runId ? [message.runId] : []))
  snapshot.tools = [...tools.values()].filter(tool => activeRuns.has(tool.runId))
  snapshot.questions = [...questions.values()]
  for (const id of Object.keys(snapshot.replyOptions)) if (!active.has(id)) delete snapshot.replyOptions[id]
  return snapshot
}

/** Deletion always trims the visible tail; the journal itself is never truncated. */
export function messageTail(snapshot: StorySnapshot, messageId: string): string[] {
  const index = snapshot.messages.findIndex(message => message.id === messageId)
  if (index < 0) throw new RpError('MESSAGE_NOT_FOUND', '这条消息已不存在，请刷新对话。', 404)
  const selected = snapshot.messages[index]!
  // The visible assistant surface owns every assistant step of its turn, including
  // earlier hidden configuration tools. User input remains independently actionable.
  return snapshot.messages.filter((message, position) => position >= index ||
    selected.role === 'assistant' && message.role === 'assistant' && message.turnId === selected.turnId).map(message => message.id)
}

/** Preserve every current user message and attachment belonging to a replayable turn. */
export function regenerationInput(snapshot: StorySnapshot, messageId: string) {
  const message = snapshot.messages.find(item => item.id === messageId)
  if (!message || snapshot.messages.filter(item => item.kind !== 'tool').at(-1)?.id !== message.id || message.kind === 'opening') {
    throw new RpError('MESSAGE_NOT_REPLAYABLE', '只能重新生成当前最后一条可恢复的消息。', 409)
  }
  const turnMessages = snapshot.messages.filter(item => item.turnId === message.turnId)
  const inputs = turnMessages.filter(item => item.role === 'user')
  if (inputs.length === 0) throw new RpError('MESSAGE_NOT_REPLAYABLE', '没有可用于重新生成的用户消息。', 409)
  return { inputs: structuredClone(inputs), removeIds: turnMessages.map(item => item.id) }
}
