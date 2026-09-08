import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, expect, test } from 'vitest'
import { Operations } from '../apps/server/src/services/operations.ts'
import { registerErrors } from '../apps/server/src/http/errors.ts'

const directories: string[] = []
async function directory() { const path = await mkdtemp(join(tmpdir(), 'rp-operations-')); directories.push(path); return path }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

test('backup gate rejects running and background work, persists across restart and resumes explicitly', async () => {
  const path = await directory(), activity = { runs: 1, background: 0 }; let resumed = 0
  const gate = new Operations(path, () => activity, () => resumed++)
  expect(() => gate.command('quiesce')).toThrow('仍有生成')
  activity.runs = 0; activity.background = 1
  expect(() => gate.command('quiesce')).toThrow('仍有生成')
  activity.background = 0
  expect(gate.command('quiesce').quiesced).toBe(true)
  const reopened = new Operations(path, () => activity, () => resumed++)
  expect(reopened.quiesced).toBe(true)
  expect(reopened.command('resume').quiesced).toBe(false)
  expect(resumed).toBe(1)
  expect(new Operations(path, () => activity, () => {}).quiesced).toBe(false)
})

test('in-flight asynchronous writes block backup and a quiesced app rejects new writes while serving reads', async () => {
  const gate = new Operations(await directory(), () => ({ runs: 0, background: 0 }), () => {})
  const app = Fastify(); gate.register(app); registerErrors(app)
  let finish!: () => void, began!: () => void, writes = 0
  const pending = new Promise<void>(resolve => { finish = resolve }), entered = new Promise<void>(resolve => { began = resolve })
  app.post('/change', async () => { began(); await pending; writes++; return { ok: true } })
  app.get('/read', async () => ({ ok: true }))
  try {
    const request = app.inject({ method: 'POST', url: '/change' }).then(result => result)
    await entered
    expect(gate.status().activeMutations).toBe(1)
    expect(() => gate.command('quiesce')).toThrow('仍有生成')
    finish(); expect((await request).statusCode).toBe(200)
    gate.command('quiesce')
    expect((await app.inject({ method: 'POST', url: '/change' })).statusCode).toBe(503)
    expect((await app.inject('/read')).statusCode).toBe(200)
    expect(writes).toBe(1)
    gate.command('resume')
    expect((await app.inject({ method: 'POST', url: '/change' })).statusCode).toBe(200)
    expect(writes).toBe(2)
  } finally { finish(); await app.close() }
})
