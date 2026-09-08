import type { ModelRequestSummary } from './trace.ts'
import type { ToolRecord } from '../../rp-core/src/types.ts'

/** Transient model progress. Never a message, Writer draft, or trajectory event. */
export interface ModelActivity {
  requestId: string
  phase: 'waiting' | 'thinking' | 'responding' | 'tool'
  text: string
  toolName?: string
}
export interface RunActivitySnapshot {
  runId: string
  requests: ModelRequestSummary[]
  live: ModelActivity[]
  tools: (Pick<ToolRecord, 'callId' | 'name' | 'parentCallId' | 'status'> & { preview: string })[]
}
