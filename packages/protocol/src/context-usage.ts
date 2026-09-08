export interface ContextUsage {
  scope: 'main' | 'writer'; runId: string; requestId: string; model: string; contextWindow: number
  at: string; input: number | null; output: number | null; used: number | null
}
