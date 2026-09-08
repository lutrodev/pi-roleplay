import type { createNamespaceSnapshot } from './state/definition.js'
import type { SummarySource } from './context/summary.ts'
import type { WorkspaceBinding } from './workspace.ts'
import type { VariableSettings } from './story/variables.ts'
import type { ModelSelection } from './agents/catalog.ts'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export type AssetKind = 'character' | 'lorebook' | 'persona' | 'preset' | 'writingStyle'
export const ASSET_KINDS: readonly AssetKind[] = ['character', 'lorebook', 'persona', 'preset', 'writingStyle']
export type ExecutionMode = 'chat' | 'agent'

export interface ModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ContextSlot {
  id: string
  label: string
  sourceIds: string[]
  locked?: boolean
  sectionTag?: boolean
  idle?: boolean
}

export interface StoryProfile {
  revision: number
  playerCharacterId?: string
  cast: { characterId: string; name?: string; controller: 'user' | 'agent' }[]
  scene: {
    title?: string
    openingSource?: 'card' | 'custom' | 'skip'
    openingIndex?: number
    openingText?: string
  }
  resources: {
    card?: { id: string }
    persona?: { id: string }
    preset?: { id: string }
    lorebooks: { id: string }[]
    writingStyles: { id: string }[]
  }
  runtime: {
    executionMode: ExecutionMode
    provider?: string
    model?: string
    reasoningEffort?: string
    maxSteps?: number
    writerRoute?: ModelSelection
    subagentRoutes?: Record<string, ModelSelection>
  }
  variables?: VariableSettings
  contextBuild?: {
    version: 1
    slots: ContextSlot[]
    customSources?: { slotId: string; content: string }[]
  }
}

export interface AssetRecord {
  id: string
  kind: AssetKind
  name: string
  revision: number
  data: JsonObject
  sourceHash: string | null
  sourceCharacterId: string | null
  avatarFileId: string | null
  createdAt: string
  updatedAt: string
}

export interface FileRecord {
  id: string
  name: string
  mimeType: string
  size: number
  sha256: string
  storageKey: string
  createdAt: string
}

export interface StoryMessage {
  id: string
  role: 'user' | 'assistant'
  kind: 'message' | 'narrative' | 'tool' | 'opening' | 'draft'
  text: string
  attachmentIds: string[]
  turnId: string
  runId: string | null
  feedback?: { rating: 'up' | 'down' | null; comment: string }
  createdAt: string
}

export interface MessageInput { text: string; attachmentIds: string[] }
export interface PendingInput {
  id: string
  storyId: string
  revision: number
  mode: 'queue' | 'steer'
  targetRunId: string | null
  inputs: MessageInput[]
  status: 'pending' | 'applied' | 'cancelled'
  appliedRunId: string | null
  createdAt: string
}

export interface StateRule {
  id: string
  target: string
  when: string
  condition?: string
  effect: { op: 'set' | 'increment' | 'append' | 'remove'; minimum?: number; maximum?: number }
  guidance: string[]
  cadence: 'when-applicable' | 'every-turn'
}
type InferredNamespace = ReturnType<typeof createNamespaceSnapshot>
export type NamespaceSnapshot = Omit<InferredNamespace, 'definition' | 'diagnostics'> & {
  definition: Omit<InferredNamespace['definition'], 'rules'> & { rules: StateRule[] }
  diagnostics: { setup: JsonObject[]; lastCommit: JsonObject[] }
}
export interface StoryState {
  namespaces: Record<string, NamespaceSnapshot>
}
export interface StateUpdate {
  namespace: string
  snapshot: NamespaceSnapshot | null
}
export interface StateEffect {
  kind: 'state.update'
  namespace: string
  expectedRevision: number
  payload: {
    changes: StateChange[]
  }
}
export type StateChange = { path: string; reason: string; ruleId?: string } & (
  { op: 'set' | 'append'; value: JsonValue } | { op: 'increment'; by: number } | { op: 'remove' }
)

export type RunStatus = 'queued' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface RunRecord {
  id: string
  storyId: string
  requestId: string
  inputHash: string
  turnId: string
  status: RunStatus
  draft: string
  error: { code: string; message: string } | null
  createdAt: string
  updatedAt: string
}

export interface ToolRecord {
  callId: string
  runId: string
  parentCallId?: string
  name: string
  arguments: JsonObject
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  result?: JsonValue
  output?: string
}

export interface QuestionItem {
  id: string
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
}
export interface QuestionAnswer { id: string; selected: string[]; custom?: string }
export interface UserQuestion {
  id: string
  runId: string
  questions: QuestionItem[]
  status: 'pending' | 'answered' | 'cancelled'
  answers?: QuestionAnswer[]
}

export interface MaintenanceRecord {
  id: string
  kind: 'summary' | 'reply-options'
  status: 'running' | 'ready' | 'completed' | 'failed' | 'discarded'
  trigger?: 'manual' | 'pressure' | 'overflow'
  sourceRevision?: number
  runId?: string
  messageId?: string
  code?: string
  message?: string
}

export interface SummaryCandidate { id: string; triggerRunId: string; source: SummarySource; text: string }

export interface CommitDiagnostic { source: string; code: string; severity: 'warning'; message: string }

export type StoryEventInput =
  | { type: 'story.created'; data: { title: string; profile: StoryProfile; bootstrap: StoryState; forkedFrom?: { storyId: string; messageId: string } } }
  | { type: 'story.renamed'; data: { title: string } }
  | { type: 'story.archived'; data: { archived: boolean } }
  | { type: 'workspace.changed'; data: WorkspaceBinding }
  | { type: 'profile.changed'; data: { profile: StoryProfile; bootstrap?: StoryState } }
  | { type: 'message.added'; data: { message: StoryMessage } }
  | { type: 'message.edited'; data: { messageId: string; text: string } }
  | { type: 'message.feedback'; data: { messageId: string; rating: 'up' | 'down' | null; comment: string } }
  | { type: 'history.inherited'; data: { version: 1; sourceStoryId: string; entries: import('./story/model-history.ts').ModelHistoryEntry[] } }
  | { type: 'story.feedback'; data: { text: string } }
  | { type: 'messages.removed'; data: { messageIds: string[]; reason: 'delete' | 'regenerate'; replacement?: { previousRunId: string; runId: string } } }
  | { type: 'turn.committed'; data: { commitId: string; fingerprint: string; runId: string; message: StoryMessage; summary: string; effects: JsonObject[]; stateUpdates: StateUpdate[]; references: JsonValue[]; extensions: JsonObject; diagnostics?: CommitDiagnostic[] } }
  | { type: 'state.configured'; data: { ownerMessageId: string; update: StateUpdate } }
  | { type: 'context.built'; data: { runId: string; writerPrompt: string; parentPrompt: string; sources: JsonValue[]; model: ModelRoute; systemPrompt?: string; writerSystemPrompt?: string; parentHistory?: StoryMessage[]; summaryForParent?: string; attachmentIds?: string[]; sourceMessageIds?: string[]; runtimePrompt?: string } }
  | { type: 'context.compacted'; data: { runId: string; basedOnContextSeq: number; parentPrompt: string; systemPrompt: string; parentHistory?: StoryMessage[]; summaryForParent?: string; sourceMessageIds?: string[]; runtimePrompt?: string } }
  | { type: 'writer.completed'; data: { runId: string; callId: string; contextSeq: number; text: string; writerHistory?: import('./agents/writer-history.ts').WriterHistoryMetadata } }
  | { type: 'model.message'; data: { runId: string; ownerMessageId: string; role: string; message: JsonObject } }
  | { type: 'run.status'; data: { runId: string; status: RunStatus; error?: { code: string; message: string } } }
  | { type: 'input.queued'; data: { item: PendingInput } }
  | { type: 'input.changed'; data: { id: string; revision: number; inputs: MessageInput[]; mode: 'queue' | 'steer'; targetRunId: string | null } }
  | { type: 'input.resolved'; data: { id: string; status: 'applied' | 'cancelled'; runId?: string } }
  | { type: 'run.draft'; data: { runId: string; text: string; replace: boolean } }
  | { type: 'tool.started'; data: ToolRecord }
  | { type: 'tool.updated'; data: { callId: string; output: string } }
  | { type: 'tool.finished'; data: { callId: string; result: JsonValue; failed: boolean } }
  | { type: 'question.asked'; data: UserQuestion }
  | { type: 'question.answered'; data: { questionId: string; answers: QuestionAnswer[] } }
  | { type: 'question.cancelled'; data: { questionId: string } }
  | { type: 'reply-options.ready'; data: { messageId: string; options: string[] } }
  | { type: 'summary.created'; data: { throughMessageId: string; text: string; sourceMessageIds: string[] } }
  | { type: 'summary.candidate'; data: SummaryCandidate }
  | { type: 'maintenance.model'; data: { id: string; role: 'request' | 'response'; message: JsonObject } }
  | { type: 'maintenance.status'; data: MaintenanceRecord }

export type StoryEvent = StoryEventInput & { seq: number; storyId: string; createdAt: string }

export interface StorySnapshot {
  id: string
  forkedFrom?: { storyId: string; messageId: string }
  title: string
  archived: boolean
  revision: number
  profile: StoryProfile
  messages: StoryMessage[]
  /** Run at the visible conversation tail; removed messages invalidate its feedback. */
  conversationRunId: string | null
  state: StoryState
  summaries: { messageId: string; text: string }[]
  tools: ToolRecord[]
  questions: UserQuestion[]
  replyOptions: Record<string, string[]>
  maintenance: Partial<Record<MaintenanceRecord['kind'], MaintenanceRecord>>
  summaryCandidate: SummaryCandidate | null
  checkpoint: { throughMessageId: string; text: string; sourceMessageIds: string[] } | null
  createdAt: string
  updatedAt: string
}
