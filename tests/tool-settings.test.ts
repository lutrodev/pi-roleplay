import { randomBytes } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ToolSettingsService } from '../apps/server/src/services/tool-settings-service.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { SubagentService } from '../apps/server/src/services/subagent-service.ts'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { AssetRepository } from '../apps/server/src/storage/asset-repository.ts'
import { StoryRepository } from '../apps/server/src/storage/story-repository.ts'
import { DEFAULT_TOOL_SETTINGS } from '../packages/rp-core/src/settings/tools.ts'
import { fixture, profile } from './helpers.ts'

const close: (() => void)[] = []
afterEach(() => close.splice(0).reverse().forEach(fn => fn()))
function setup() {
  const x = fixture(); close.push(x.close)
  const key = randomBytes(32), route = { provider: 'test', model: 'test-model' }
  const models = new ModelRegistry([{ ...route, api: 'openai-completions', baseUrl: 'https://model.test/v1', keyEnv: 'MODEL_TEST', contextWindow: 32000, maxTokens: 1000 }], { env: () => 'synthetic-model-key' })
  const initial = { baseUrl: 'https://search.test/anthropic', model: 'search-model', keyEnv: 'SEARCH_TEST', maxUses: 3 }
  const service = new ToolSettingsService(x.assets, key, initial, name => name === 'SEARCH_TEST' ? 'synthetic-deploy-search-key' : undefined)
  return { ...x, key, models, route, service }
}

it('keeps captured search requests and limits stable while saving an encrypted replacement for subsequent runs', async () => {
  const x = setup(), requests: { url: string; key: string | null; body: unknown }[] = []
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), key: new Headers(init?.headers).get('x-api-key'), body: JSON.parse(String(init?.body)) })
    return Response.json({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://source.test/page', title: 'Source' }] }] })
  }
  const captured = x.service.capture(fetcher), current = x.service.snapshot()
  expect(current.searchKey).toEqual({ configured: true, source: 'environment' })
  const next = { ...current.settings, commandTimeoutMs: 50, maxOutputBytes: 32, maxParallelToolCalls: 2, search: { baseUrl: 'https://replacement.test/api', model: 'replacement', maxUses: 1 } }
  const updated = x.service.update(current.revision, next, 'synthetic-web-search-secret')
  expect(updated).toMatchObject({ revision: 2, settings: next, searchKey: { configured: true, source: 'saved' } })
  expect(JSON.stringify(updated)).not.toContain('synthetic-web-search-secret')
  expect(JSON.stringify(x.assets.getSetting('tools.settings'))).not.toContain('synthetic-web-search-secret')
  expect(captured.settings.commandTimeoutMs).toBe(DEFAULT_TOOL_SETTINGS.commandTimeoutMs)
  const logs: unknown[] = [], signal = new AbortController().signal
  await captured.search.search('first query', 5, signal, value => logs.push(value))
  const restarted = new ToolSettingsService(x.assets, x.key)
  await restarted.capture(fetcher).search.search('next query', 5, signal, value => logs.push(value))
  expect(requests[0]).toMatchObject({ url: 'https://search.test/anthropic/messages', key: 'synthetic-deploy-search-key', body: { model: 'search-model', tools: [{ max_uses: 3 }] } })
  expect(requests[1]).toMatchObject({ url: 'https://replacement.test/api/messages', key: 'synthetic-web-search-secret', body: { model: 'replacement', tools: [{ max_uses: 1 }] } })
  expect(JSON.stringify(logs)).not.toContain('synthetic-web-search-secret')
  expect(() => new ToolSettingsService(x.assets, randomBytes(32))).toThrow('无法解密')
  restarted.update(2, next, undefined, true)
  expect(restarted.snapshot().searchKey).toEqual({ configured: false, source: 'none' })
  await expect(restarted.capture(fetcher).search.search('must not leave', 5, signal, () => {})).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' })
  expect(requests).toHaveLength(2)
})

it('validates complete settings, rejects retired model-selection fields and rejects stale edits', () => {
  const x = setup(), before = x.service.snapshot()
  for (const patch of [
    { commandTimeoutMs: 0 }, { maxOutputBytes: 0 }, { maxParallelToolCalls: 9 },
    { search: { ...before.settings.search, baseUrl: 'https://user:password@search.test/api' } },
    { search: { ...before.settings.search, model: '' } },
    { subagentModels: { enabled: true, allowed: [x.route] } },
    { keyEnv: 'ANOTHER_SERVER_SECRET' },
  ]) expect(() => x.service.update(before.revision, { ...before.settings, ...patch })).toThrow()
  expect(x.service.snapshot()).toEqual(before)
  const settings = { ...before.settings, commandTimeoutMs: 12345 }
  x.service.update(1, settings)
  expect(() => x.service.update(1, before.settings)).toThrow('已经更新')
  x.service.update(2, { ...settings, maxOutputBytes: 128 })
  expect(x.service.snapshot().settings).toEqual({ ...settings, maxOutputBytes: 128 })
  const stored = x.assets.getSetting('tools.settings')
  expect(() => x.service.update(3, settings, 'synthetic-secret', true)).toThrow('同时')
  expect(x.assets.getSetting('tools.settings')).toEqual(stored)
})

it.each([false, true])('removes persisted automatic selection once and restores old backups without losing routes or search credentials (saved key: %s)', async savedKey => {
  const x = setup(), subagents = new SubagentService(x.assets, x.models)
  subagents.updateWriter(1, { kind: 'fixed', ...x.route })
  const catalog = subagents.snapshot(), config = profile()
  config.runtime.writerRoute = { kind: 'inherit' }
  config.runtime.subagentRoutes = { [catalog.subagents[0]!.id]: { kind: 'fixed', ...x.route } }
  const story = x.stories.create('保留会话选模', config)
  if (savedKey) x.service.update(1, x.service.snapshot().settings, 'synthetic-saved-search-key')
  const before = x.service.snapshot(), stored = JSON.parse(JSON.stringify(x.assets.getSetting('tools.settings')))
  x.assets.setSetting('tools.settings', { ...stored, version: 1, settings: { ...stored.settings, subagentModels: { enabled: true, allowed: [x.route] } } })
  x.database.sqlite.prepare('DELETE FROM __rp_migrations WHERE version = ?').run(7)
  const backup = join(x.directory, 'legacy-backup.sqlite'), restored = join(x.directory, 'restored.sqlite')
  await x.database.sqlite.backup(backup); await copyFile(backup, restored)

  for (const filename of [x.filename, restored, x.filename]) {
    const database = new AppDatabase(filename); close.push(() => database.close())
    const assets = new AssetRepository(database), service = new ToolSettingsService(assets, x.key, undefined, name => name === 'SEARCH_TEST' ? 'synthetic-deploy-search-key' : undefined)
    expect(service.snapshot()).toEqual({ ...before, revision: before.revision + 1 })
    expect(assets.getSetting('tools.settings')).toEqual({ ...stored, version: 2, revision: before.revision + 1 })
    expect(new SubagentService(assets, x.models).snapshot()).toEqual(catalog)
    expect(new StoryRepository(database).snapshot(story.id)).toEqual(story)
    expect(() => service.update(before.revision, before.settings)).toThrow('已经更新')
    const requests: { url: string; key: string | null }[] = []
    await service.capture(async (url, init) => {
      requests.push({ url: String(url), key: new Headers(init?.headers).get('x-api-key') })
      return Response.json({ content: [{ type: 'web_search_tool_result', content: [] }] })
    }).search.search('恢复验证', 1, new AbortController().signal, () => {})
    expect(requests).toEqual([{ url: 'https://search.test/anthropic/messages', key: savedKey ? 'synthetic-saved-search-key' : 'synthetic-deploy-search-key' }])
  }
})
