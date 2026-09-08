import { expect, it } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { runIsolated } from '../apps/server/src/runtime/isolated.ts'

async function runBatch(names: string[], limit: number) {
  const route = { provider: 'synthetic', model: 'parallel-tools' }, requests: Record<string, unknown>[] = []
  const models = new ModelRegistry([{ ...route, api: 'openai-completions', keyEnv: 'TEST_KEY', baseUrl: 'https://model.test/v1', contextWindow: 32000, maxTokens: 1000 }], {
    env: () => 'synthetic-key', fetch: async (_url, init) => {
      const first = requests.length === 0; requests.push(JSON.parse(String(init?.body)))
      const delta = first ? { role: 'assistant', tool_calls: names.map((name, index) => ({ index, id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify({ index }) } })) } : { role: 'assistant', content: '全部完成。' }
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  let active = 0, maximum = 0
  const started: number[] = [], finished: number[] = []
  const tools: AgentTool[] = [...new Set(names)].map(name => ({ name, label: name, description: 'Controlled concurrency probe.', parameters: Type.Object({ index: Type.Integer() }),
    execute: async (_id, input) => {
      const { index } = input as { index: number }
      active++; maximum = Math.max(maximum, active); started.push(index)
      try { await new Promise(resolve => setTimeout(resolve, index % 2 ? 5 : 20)); finished.push(index); return { content: [{ type: 'text', text: String(index) }], details: {} } }
      finally { active-- }
    },
  }))
  await runIsolated(models, { route, systemPrompt: 'Check tool execution.', prompt: 'Run the probes.', tools, images: [], maxSteps: 3, maxParallelToolCalls: limit, signal: new AbortController().signal })
  return { requests, maximum, started, finished }
}

it('bounds the actual Pi parallel batch and retains model-facing result order even when calls finish out of order', async () => {
  const result = await runBatch(['read', 'read', 'read', 'read'], 2)
  expect(result.maximum).toBe(2)
  expect(result.started).toEqual([0, 1, 2, 3])
  expect(result.finished[0]).toBe(1)
  const results = (result.requests[1]!.messages as { role: string; tool_call_id?: string }[]).filter(message => message.role === 'tool')
  expect(results.map(message => message.tool_call_id)).toEqual(['call-0', 'call-1', 'call-2', 'call-3'])
})

it('executes a mixed batch in order when it contains a file write, even with a higher concurrency setting', async () => {
  const result = await runBatch(['read', 'write', 'read'], 4)
  expect(result.maximum).toBe(1)
  expect(result.finished).toEqual([0, 1, 2])
})
