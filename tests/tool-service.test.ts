import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createToolServer } from '../apps/tools/src/server.ts'
import { ToolClient } from '../apps/server/src/runtime/tool-client.ts'
import type { ShellResult } from '../packages/protocol/src/tools.ts'

describe('tools HTTP boundary', () => {
  let directory: string, server: ReturnType<typeof createToolServer>, client: ToolClient, url: string, storyId: string
  const token = 'synthetic-test-token-0123456789abcdef', signal = () => new AbortController().signal
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'rp-tools-http-')))
    for (const name of ['workspaces', 'inputs', 'skills']) await mkdir(join(directory, name))
    server = createToolServer({ token, roots: { workspaces: join(directory, 'workspaces'), inputs: join(directory, 'inputs'), skills: join(directory, 'skills') } })
    url = await server.app.listen({ host: '127.0.0.1', port: 0 })
    client = new ToolClient(url, token); storyId = randomUUID()
  })
  afterEach(async () => { await server?.app.close(); if (directory) await rm(directory, { recursive: true, force: true }) })

  it('requires authentication and rejects unknown fields without stripping the command', async () => {
    expect((await fetch(url + '/health')).status).toBe(401)
    const invalid = await fetch(url + '/v1/execute', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), storyId, workspace: { directory: storyId, access: 'read-write', createIfMissing: true }, command: { kind: 'bash', command: 'printf safe', arbitrary: true } }),
    })
    expect(invalid.status).toBe(400)
    expect(await client.health()).toMatchObject({ ok: true, active: 0, shells: 0 })
  })

  it('streams output, preserves Bash state and accesses the same files over RPC', async () => {
    const chunks: string[] = []
    const result = await client.execute(storyId, { kind: 'bash', command: 'printf "%01000d" 0; printf "甲\\n乙" > note.txt; export RP_RPC_VALUE=retained' }, { signal: signal(), onOutput: text => chunks.push(text) }) as ShellResult
    expect(chunks.join('')).toBe(result.output)
    expect(result.output.length).toBe(1000)
    expect(await client.execute(storyId, { kind: 'read', path: 'note.txt' }, { signal: signal() })).toMatchObject({ text: '甲\n乙' })
    expect(await client.execute(storyId, { kind: 'bash', command: 'printf "%s" "$RP_RPC_VALUE"' }, { signal: signal() })).toMatchObject({ output: 'retained', shellState: 'retained' })
    await client.reset(storyId)
    expect(await client.execute(storyId, { kind: 'bash', command: 'printf "%s" "${RP_RPC_VALUE-new}"' }, { signal: signal() })).toMatchObject({ output: 'new', shellState: 'new' })
  })

  it('returns recent duplicate results without rerunning mutations and rejects conflicting IDs', async () => {
    const requestId = randomUUID(), command = { kind: 'bash' as const, command: 'printf x >> counter.txt' }
    const first = await client.execute(storyId, command, { signal: signal(), requestId })
    expect(await client.execute(storyId, command, { signal: signal(), requestId })).toEqual(first)
    expect(await client.execute(storyId, { kind: 'read', path: 'counter.txt' }, { signal: signal() })).toMatchObject({ text: 'x' })
    await expect(client.execute(storyId, { kind: 'bash', command: 'printf wrong >> counter.txt' }, { signal: signal(), requestId })).rejects.toMatchObject({ code: 'TOOL_REQUEST_CONFLICT' })
  })

  it('shares branch files, keeps independent Bash state and serializes writes across the shared workspace', async () => {
    const branchId = randomUUID(), workspaceFor = (id: string) => ({ directory: id === branchId ? storyId : id, access: 'read-write' as const, createIfMissing: true })
    client = new ToolClient(url, token, fetch, workspaceFor)
    const requestId = randomUUID(), command = { kind: 'bash' as const, command: 'export RP_BRANCH_VALUE=original; printf original > shared.txt' }
    await client.execute(storyId, command, { signal: signal(), requestId })
    expect(await client.execute(branchId, { kind: 'read', path: '/workspace/shared.txt' }, { signal: signal() })).toMatchObject({ text: 'original' })
    expect(await client.execute(branchId, { kind: 'bash', command: 'printf "%s" "${RP_BRANCH_VALUE-new}"; export RP_BRANCH_VALUE=branch; printf branch > shared.txt' }, { signal: signal() })).toMatchObject({ output: 'new', shellState: 'new' })
    expect(await client.execute(storyId, { kind: 'bash', command: 'printf "%s" "$RP_BRANCH_VALUE"' }, { signal: signal() })).toMatchObject({ output: 'original', shellState: 'retained' })
    expect(await client.execute(storyId, { kind: 'read', path: 'shared.txt' }, { signal: signal() })).toMatchObject({ text: 'branch' })
    const wrongWorkspace = new ToolClient(url, token, fetch, () => ({ directory: randomUUID(), access: 'read-write', createIfMissing: true }))
    await expect(wrongWorkspace.execute(storyId, command, { signal: signal(), requestId })).rejects.toMatchObject({ code: 'TOOL_REQUEST_CONFLICT' })
    expect(await wrongWorkspace.execute(storyId, { kind: 'list' }, { signal: signal() })).toMatchObject({ entries: [] })

    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve }), controller = new AbortController()
    const running = client.execute(branchId, { kind: 'bash', command: 'printf "%01000d" 0; sleep 30' }, { signal: controller.signal, onOutput: () => markStarted() })
      .catch(error => error)
    await started
    let written = false
    const waitingWrite = client.execute(storyId, { kind: 'edit', command: 'create', path: 'blocked.txt', fileText: 'after cancellation' }, { signal: signal() }).then(() => { written = true })
    await expect(client.reset(branchId)).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' })
    await client.reset(storyId)
    expect((await client.health()).active).toBe(1)
    expect(written).toBe(false)
    controller.abort(); expect(await running).toMatchObject({ code: 'TOOL_CANCELLED' })
    await waitingWrite
    expect(await client.execute(branchId, { kind: 'read', path: 'blocked.txt' }, { signal: signal() })).toMatchObject({ text: 'after cancellation' })
    await expect.poll(async () => (await client.health()).active).toBe(0)
    await client.execute(storyId, { kind: 'edit', command: 'create', path: 'released.txt', fileText: 'released' }, { signal: signal() })
    expect(await client.execute(branchId, { kind: 'read', path: 'released.txt' }, { signal: signal() })).toMatchObject({ text: 'released' })
  })

  it('cancels a live request through the service and resets its shell', async () => {
    const controller = new AbortController()
    const running = client.execute(storyId, { kind: 'bash', command: 'export RP_RPC_CANCEL=old; printf "%01000d" 0; sleep 30' }, {
      signal: controller.signal, onOutput: () => controller.abort(),
    })
    await expect(running).rejects.toMatchObject({ code: 'TOOL_CANCELLED' })
    await expect.poll(async () => (await client.health()).active).toBe(0)
    expect(await client.execute(storyId, { kind: 'bash', command: 'printf "%s" "${RP_RPC_CANCEL-new}"' }, { signal: signal() })).toMatchObject({ output: 'new', shellState: 'new' })
  })
})

it('never automatically retries a dispatch that ends before its final result', async () => {
  let requests = 0
  const client = new ToolClient('http://tools:3092', 'synthetic-test-token-0123456789abcdef', (async () => {
    requests += 1
    return new Response('{"type":"output","text":"partial"}\n', { headers: { 'content-type': 'application/x-ndjson' } })
  }) as typeof fetch)
  await expect(client.execute(randomUUID(), { kind: 'bash', command: 'printf one' }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'TOOL_OUTCOME_UNKNOWN' })
  expect(requests).toBe(1)
})
