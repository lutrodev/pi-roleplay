import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { contextPruner, PRUNE_MARKER, pruneToolMessages, type PruneRecord } from '../apps/server/src/runtime/tool-pruner.ts'

describe('model-only tool text pruning', () => {
  it('preserves Unicode, image order, error metadata and tool pairing without mutating the original transcript', () => {
    const image = { type: 'image' as const, data: 'AA==', mimeType: 'image/png' }
    const original: AgentMessage = { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', isError: true, timestamp: 1,
      content: [{ type: 'text', text: '😀'.repeat(5000) }, image, { type: 'text', text: '界'.repeat(5000) }] }
    const before = structuredClone(original), records: PruneRecord[] = []
    const pruned = pruneToolMessages([original], record => records.push(record))[0]!
    expect(original).toEqual(before)
    expect(pruned).toMatchObject({ role: 'toolResult', toolCallId: 'call-1', toolName: 'read', isError: true, content: [{ type: 'text', text: '😀'.repeat(4096) + PRUNE_MARKER }, image, { type: 'text', text: '界'.repeat(1024) }] })
    expect(records[0]).toMatchObject({ beforeCharacters: 10000, afterCharacters: 5120 + [...PRUNE_MARKER].length })
  })
  it('keeps authoritative RP, Skill and specialist output complete and journals each stable pruning only once', async () => {
    const messages: AgentMessage[] = ['rp_write_turn', 'rp_run_subagent', 'skill', 'rp_asset_read', 'rp_state_read'].map(name => ({ role: 'toolResult', toolCallId: name, toolName: name, content: [{ type: 'text', text: '重要内容'.repeat(3000) }], isError: false, timestamp: 0 }))
    expect(pruneToolMessages(messages)).toEqual(messages)
    const records: PruneRecord[] = [], transform = contextPruner(value => records.push(value))
    const shell: AgentMessage = { role: 'toolResult', toolCallId: 'bash-1', toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(16000) }], isError: false, timestamp: 1 }
    await transform([...messages, shell]); await transform([...messages, shell])
    expect(records).toHaveLength(1)
  })
})
