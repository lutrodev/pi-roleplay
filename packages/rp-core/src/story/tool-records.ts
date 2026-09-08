import type { StoryEvent, ToolRecord } from '../types.ts'

/** Audit tools survive removal or regeneration of their narrative messages. */
export function projectRunTools(events: readonly StoryEvent[], runId: string): ToolRecord[] {
  const tools = new Map<string, ToolRecord>()
  for (const event of events) {
    if (event.type === 'tool.started' && event.data.runId === runId) tools.set(event.data.callId, structuredClone(event.data))
    else if (event.type === 'tool.updated') {
      const tool = tools.get(event.data.callId)
      if (tool) tool.output = (tool.output ?? '') + event.data.output
    } else if (event.type === 'tool.finished') {
      const tool = tools.get(event.data.callId)
      if (tool) { tool.result = structuredClone(event.data.result); tool.status = event.data.failed ? 'failed' : 'completed' }
    } else if (event.type === 'run.status' && event.data.runId === runId && ['cancelled', 'failed', 'interrupted'].includes(event.data.status)) {
      for (const tool of tools.values()) if (tool.status === 'running') tool.status = 'interrupted'
    }
  }
  return [...tools.values()]
}
