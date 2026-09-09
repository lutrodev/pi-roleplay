import { expect, it } from 'vitest'
import { WorkspaceDispatch } from '../apps/server/src/runtime/workspace-dispatch.ts'
import { ToolClient } from '../apps/server/src/runtime/tool-client.ts'

it('serializes overlapping mutations, allows other directories, and prevents reads from starving a writer', async () => {
  const queue = new WorkspaceDispatch(), signal = new AbortController().signal, started: string[] = []
  const first = await queue.acquire('shared', false, signal)
  const writer = queue.acquire('shared/child', true, signal).then(release => { started.push('writer'); return release })
  const reader = queue.acquire('shared', false, signal).then(release => { started.push('reader'); return release })
  const other = await queue.acquire('different', true, signal)
  expect(started).toEqual([])
  first(); const releaseWriter = await writer
  expect(started).toEqual(['writer'])
  releaseWriter(); const releaseReader = await reader
  expect(started).toEqual(['writer', 'reader'])
  releaseReader(); other()
})

it('removes an aborted waiting writer and wakes compatible reads', async () => {
  const queue = new WorkspaceDispatch(), signal = new AbortController().signal, abort = new AbortController()
  const first = await queue.acquire('shared', false, signal)
  const writer = queue.acquire('shared', true, abort.signal), rejection = expect(writer).rejects.toBeDefined()
  const read = queue.acquire('shared', false, signal)
  abort.abort(); await rejection
  const release = await read; release(); first()
})

it('never dispatches a cancelled queued tool, preserving the shared workspace and unrelated requests', async () => {
  const calls: { path: string; id: string; finish: () => void }[] = [], signal = new AbortController().signal, abort = new AbortController()
  const client = new ToolClient('http://tools.invalid', 'synthetic-token-that-is-long-enough', async (url, init) => {
    const request = JSON.parse(String(init?.body))
    return await new Promise<Response>(resolve => calls.push({ path: String(url), id: request.storyId, finish: () => resolve(new Response(JSON.stringify({ type: 'result', value: request.storyId }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } })) }))
  }, id => ({ directory: id === 'independent' ? 'other' : 'shared', access: 'read-write', createIfMissing: true }))
  const first = client.execute('first', { kind: 'bash', command: 'synthetic' }, { signal })
  await expect.poll(() => calls.length).toBe(1)
  const cancelled = client.execute('cancelled', { kind: 'bash', command: 'synthetic' }, { signal: abort.signal }), rejection = expect(cancelled).rejects.toBeDefined()
  const next = client.execute('next', { kind: 'bash', command: 'synthetic' }, { signal })
  const independent = client.execute('independent', { kind: 'bash', command: 'synthetic' }, { signal })
  await expect.poll(() => calls.map(item => item.id)).toEqual(['first', 'independent'])
  abort.abort(); await rejection
  calls[0]!.finish(); expect(await first).toBe('first')
  await expect.poll(() => calls.map(item => item.id)).toEqual(['first', 'independent', 'next'])
  calls[1]!.finish(); calls[2]!.finish()
  expect(await independent).toBe('independent'); expect(await next).toBe('next')
  expect(calls.every(item => item.path.endsWith('/v1/execute'))).toBe(true)
})
