import type { ModelRequestSummary } from './trace.ts'
import type { ToolRecord } from '../../rp-core/src/types.ts'

/** Transient model progress. Never a message, Writer draft, or trajectory event. */
export interface ModelActivity {
  requestId: string
  phase: 'queued' | 'waiting' | 'thinking' | 'responding' | 'tool'
  text: string
  toolName?: string
  updatedAt: string
  outputCharacters: number
}
export interface ActivityTool extends Pick<ToolRecord, 'callId' | 'name' | 'parentCallId' | 'status'> {
  preview: string
  startedAt: string
  updatedAt: string
  finishedAt?: string
}
/** One invocation, spanning all of its model requests and tools. Completion belongs to the outer call. */
export interface AgentActivity {
  callId: string
  parentCallId?: string
  kind: 'writer' | 'task'
  name: string
  task: string
  status: ToolRecord['status'] | 'cancelled'
  phase: ModelActivity['phase'] | 'tools' | 'continuing' | 'waiting_user'
  startedAt: string
  updatedAt: string
  finishedAt?: string
  model?: string
  requestCount: number
  text: string
  tools: ActivityTool[]
  toolCount: number
}
export interface RunActivitySnapshot {
  runId: string
  requests: ModelRequestSummary[]
  live: ModelActivity[]
  tools: ActivityTool[]
  agents: AgentActivity[]
}
