import type { AgentTool } from '@earendil-works/pi-agent-core'

const parallelTools = new Set(['read', 'read_image', 'web_search', 'skill', 'rp_asset_read', 'rp_state_read', 'rp_run_subagent'])

/** Pi owns dispatch and result order. A semaphore bounds independent reads; any mutation keeps the batch sequential. */
export function boundedTools(tools: AgentTool[], limit: number): AgentTool[] {
  let active = 0
  const waiting: { start: () => void; cancel: () => void }[] = []
  const acquire = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const item = {
      start: () => { signal?.removeEventListener('abort', item.cancel); active++; resolve() },
      cancel: () => { const index = waiting.indexOf(item); if (index >= 0) waiting.splice(index, 1); reject(signal?.reason) },
    }
    if (active < limit) item.start()
    else { waiting.push(item); signal?.addEventListener('abort', item.cancel, { once: true }) }
  })
  const release = () => { active--; waiting.shift()?.start() }
  return tools.map(tool => ({ ...tool, executionMode: parallelTools.has(tool.name) ? 'parallel' : 'sequential',
    execute: async (id, args, signal, update) => {
      await acquire(signal)
      try { signal?.throwIfAborted(); return await tool.execute(id, args, signal, update) }
      finally { release() }
    },
  }))
}
