import { createServer } from 'node:net'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { developmentEnvironment, developmentPorts, assertPortAvailable, prepareDevelopment } from '../scripts/dev-support.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

it('uses the requested uncommon defaults and refuses collisions, invalid ports, and the old service port', async () => {
  expect(developmentPorts()).toEqual({ api: 18768, web: 18767 })
  for (const [api, web] of [['3080', '18767'], ['18767', '18767'], ['0', '18767'], ['65536', '18767'], ['1.5', '18767']]) expect(() => developmentPorts(api, web)).toThrow()
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  await expect(assertPortAvailable(port)).rejects.toThrow('不会停止已有服务')
  expect(server.listening).toBe(true)
})

it('creates private stable keys and preserves data, rejecting links instead of following another directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'rp-dev-entry-')), directory = join(parent, '.dev')
  cleanups.push(() => rm(parent, { recursive: true, force: true }))
  await prepareDevelopment(directory)
  const key = await readFile(join(directory, 'session_key')), token = await readFile(join(directory, 'tool_token'))
  await writeFile(join(directory, 'data/story.txt'), 'keep')
  await prepareDevelopment(directory)
  expect(await readFile(join(directory, 'session_key'))).toEqual(key)
  expect(await readFile(join(directory, 'tool_token'))).toEqual(token)
  expect(key.length).toBe(32)
  expect((await stat(join(directory, 'session_key'))).mode & 0o777).toBe(0o600)
  expect(await readFile(join(directory, 'data/story.txt'), 'utf8')).toBe('keep')
  await symlink(directory, join(parent, 'linked'))
  await expect(prepareDevelopment(join(parent, 'linked'))).rejects.toThrow('普通目录')
  await writeFile(join(directory, 'session_key'), 'invalid')
  await expect(prepareDevelopment(directory)).rejects.toThrow('不会覆盖')
  expect(await readFile(join(directory, 'session_key'), 'utf8')).toBe('invalid')
})

it('builds development origins and paths without inheriting production RP or Compose settings', () => {
  const previous = { ...process.env }
  Object.assign(process.env, { RP_DATA_DIR: '/production', RP_MODELS_FILE: '/production-models', RP_MODEL_API_KEY: 'test-production-value', COMPOSE_PROJECT_NAME: 'production' })
  try {
    const env = developmentEnvironment('/tmp/isolated', 28768, 28767, 'http://127.0.0.1:19765')
    expect(env.RP_DATA_DIR).toBe('/tmp/isolated/data')
    expect(env.RP_PUBLIC_ORIGIN).toBe('http://127.0.0.1:28767')
    expect(env.RP_PORT).toBe('28768')
    expect(env.RP_TOOLS_URL).toBe('http://127.0.0.1:19765')
    expect(env.RP_MODELS_FILE).toBeUndefined()
    expect(env.RP_MODEL_API_KEY).toBeUndefined()
    expect(env.COMPOSE_PROJECT_NAME).toBeUndefined()
  } finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous) }
})
