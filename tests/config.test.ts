import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, parseModelConfig } from '../apps/server/src/config.ts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
describe('VPS process configuration', () => {
  it('uses explicit secret files and an optional model catalog, and rejects the old service port or credential-bearing origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-config-')); directories.push(dir)
    const session = randomBytes(32), token = 'synthetic-tools-token-0123456789abcdef'
    await writeFile(join(dir, 'session'), session); await writeFile(join(dir, 'token'), token)
    const env = { RP_SESSION_KEY_FILE: join(dir, 'session'), RP_TOOL_TOKEN_FILE: join(dir, 'token'), RP_PUBLIC_ORIGIN: 'https://rp.example.test', RP_DATA_DIR: join(dir, 'data') }
    const loaded = await loadConfig(env)
    expect(loaded.config.sessionKey).toEqual(session); expect(loaded.config.tools.token).toBe(token)
    expect(loaded.config.models).toEqual([]); expect(loaded.config.defaultMain).toBe(null); expect(loaded.port).toBe(3091)
    await expect(loadConfig({ ...env, RP_PORT: '3080' })).rejects.toThrow('3080')
    await expect(loadConfig({ ...env, RP_PUBLIC_ORIGIN: 'https://password@rp.example.test' })).rejects.toThrow('凭据')
    await writeFile(join(dir, 'session'), randomBytes(31))
    await expect(loadConfig(env)).rejects.toThrow('32 字节')
  })
  it('rejects inline secrets, undefined default routes, and search URLs with query credentials', () => {
    const model = { provider: 'test', model: 'test', keyEnv: 'RP_MODEL_KEY' }
    expect(() => parseModelConfig({ models: [{ ...model, apiKey: 'inline-secret' }] })).toThrow('keyEnv')
    expect(() => parseModelConfig({ models: [model], main: { provider: 'test', model: 'missing' } })).toThrow('models 列表')
    expect(() => parseModelConfig({ models: [model], search: { baseUrl: 'https://search.test/v1?key=secret', model: 'test', keyEnv: 'RP_MODEL_KEY' } })).toThrow('搜索地址')
    expect(parseModelConfig({ models: [model], main: { provider: 'test', model: 'test' } }).main).toEqual({ provider: 'test', model: 'test' })
  })
})
