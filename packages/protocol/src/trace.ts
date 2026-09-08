import type { RunRecord, ToolRecord } from '../../rp-core/src/types.ts'

export interface ModelUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total: number } }
export interface ModelRequestSummary {
  id: string; scope: string; parentCallId?: string; provider: string; model: string; startedAt: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'truncated'
  elapsedMs?: number; firstTokenMs?: number; usage?: ModelUsage
}
export interface TraceTool extends ToolRecord { startedAt?: string; finishedAt?: string; elapsedMs?: number }
export interface RunTrace { run: RunRecord; requests: ModelRequestSummary[]; tools: TraceTool[]; matches: string[] }
export interface LogSummary { seq: number; type: string; createdAt: string; characters: number; runId?: string }

export type TrajectoryKind = 'system' | 'user' | 'context' | 'assistant' | 'tool' | 'commit'
export type TrajectoryStatus = ModelRequestSummary['status'] | 'waiting_user' | 'queued'
/** The ledger contains previews only; full payloads are fetched when a row is inspected. */
export interface TrajectoryEntry {
  id: string; seq: number; kind: TrajectoryKind; agentId: string; title: string; preview: string; resultPreview?: string
  startedAt: string; elapsedMs?: number; status?: TrajectoryStatus; model?: string
  history?: { round: number }
  detail: { type: 'request'; requestId: string; messageIndex?: number } | { type: 'tool'; callId: string } | { type: 'event'; seq: number }
}
export interface TrajectoryAgent {
  id: string; parentId: string; entryId: string; name: string; task: string; status: TrajectoryStatus
  startedAt: string; elapsedMs?: number; requestCount: number; errorCount: number
}
export interface RunTrajectory {
  run: RunRecord; entries: TrajectoryEntry[]; agents: TrajectoryAgent[]; requests: ModelRequestSummary[]; matches: string[]; inputPreview: string
}
export interface TrajectoryAttempt {
  runId: string; attempt: number; disposition: 'current' | 'superseded' | 'deleted'; removedAt?: number
}
export interface TrajectoryRound {
  id: string; cursor: number; round: number; state: 'active' | 'input-only' | 'deleted'
  attempts: TrajectoryAttempt[]; trajectory: RunTrajectory
}
/** Cursors are immutable first-event sequences, not mutable display round numbers. */
export interface StoryTrajectory {
  rounds: TrajectoryRound[]; revision: number; totalRounds: number; deletedRounds: number; totalItems: number
  beforeCursor: number | null; afterCursor: number | null
}
