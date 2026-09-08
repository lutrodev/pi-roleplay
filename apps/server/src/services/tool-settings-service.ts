import { objectInput } from '../../../../packages/rp-core/src/input.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { DEFAULT_TOOL_SETTINGS, normalizeToolSettings, type ToolSettings } from '../../../../packages/rp-core/src/settings/tools.ts'
import type { JsonValue } from '../../../../packages/rp-core/src/types.ts'
import { DeepSeekSearch, type SearchConfig } from '../runtime/search.ts'
import type { AssetRepository } from '../storage/asset-repository.ts'
import { CredentialCipher } from '../storage/credential-cipher.ts'

const storageKey = 'tools.settings'
interface Stored { version: 2; revision: number; settings: ToolSettings; searchKeyEnv: string | null; searchSecret: string | null }
export interface ToolSettingsSnapshot {
  revision: number
  settings: ToolSettings
  searchKey: { configured: boolean; source: 'saved' | 'environment' | 'none' }
}

/** Settings are captured when a run starts. Updates cannot change a running tool's limits or credentials. */
export class ToolSettingsService {
  private readonly cipher: CredentialCipher
  constructor(readonly assets: AssetRepository, sessionKey: Buffer, initialSearch?: SearchConfig,
    readonly env: (name: string) => string | undefined = name => process.env[name]) {
    this.cipher = new CredentialCipher(sessionKey, 'pi-roleplay/search-credentials/v1\0')
    if (assets.getSetting(storageKey) === undefined) {
      const settings = structuredClone(DEFAULT_TOOL_SETTINGS)
      if (initialSearch) settings.search = { baseUrl: initialSearch.baseUrl, model: initialSearch.model, maxUses: initialSearch.maxUses ?? 5 }
      this.save({ version: 2, revision: 1, settings: normalizeToolSettings(settings), searchKeyEnv: initialSearch?.keyEnv ?? null, searchSecret: null })
    }
    this.snapshot()
  }
  snapshot(): ToolSettingsSnapshot {
    const stored = this.read(), key = this.key(stored)
    return { revision: stored.revision, settings: stored.settings,
      searchKey: { configured: Boolean(key?.trim()), source: stored.searchSecret ? 'saved' : stored.searchKeyEnv ? 'environment' : 'none' } }
  }
  update(expectedRevision: number, input: unknown, apiKey?: string, clearKey = false) {
    const settings = normalizeToolSettings(input)
    requireValue(apiKey === undefined || typeof apiKey === 'string' && apiKey.trim().length > 0 && apiKey.length <= 8192 && !/[\r\n\0]/.test(apiKey),
      'INVALID_TOOL_SETTINGS', '搜索 API 密钥格式不正确。')
    requireValue(typeof clearKey === 'boolean' && !(clearKey && apiKey !== undefined), 'INVALID_TOOL_SETTINGS', '不能同时替换和移除搜索密钥。')
    this.assets.database.transaction(() => {
      const current = this.read()
      requireValue(current.revision === expectedRevision, 'REVISION_CONFLICT', '工具设置已经更新，请刷新后再保存。', 409)
      this.save({ ...current, revision: current.revision + 1, settings,
        searchSecret: apiKey ? this.cipher.encrypt('search', apiKey.trim()) : clearKey ? null : current.searchSecret,
        searchKeyEnv: apiKey || clearKey ? null : current.searchKeyEnv })
    })
    return this.snapshot()
  }
  capture(fetcher?: typeof fetch) {
    const stored = this.read(), apiKey = this.key(stored)
    const search = new DeepSeekSearch(() => {
      requireValue(stored.settings.search.baseUrl && stored.settings.search.model, 'SEARCH_NOT_CONFIGURED', '搜索尚未配置，请在工具设置中填写搜索专用端点、模型和密钥。')
      return { ...stored.settings.search, keyEnv: 'RP_SEARCH_API_KEY' }
    }, { fetch: fetcher, env: () => apiKey })
    return { settings: stored.settings, search }
  }
  private key(stored: Stored) {
    if (!stored.searchSecret) return stored.searchKeyEnv ? this.env(stored.searchKeyEnv) : undefined
    try { return this.cipher.decrypt('search', stored.searchSecret) }
    catch { throw new RpError('SEARCH_KEY_DECRYPT_FAILED', '搜索密钥无法解密；恢复备份时必须同时使用原 Cookie 密钥文件。', 500) }
  }
  private read(): Stored {
    try {
      const value = this.assets.getSetting(storageKey)
      objectInput(value)
      requireValue(Object.keys(value).sort().join(',') === 'revision,searchKeyEnv,searchSecret,settings,version' && value.version === 2 && Number.isSafeInteger(value.revision) && Number(value.revision) > 0,
        'TOOL_SETTINGS_CORRUPT', '工具设置版本不正确。')
      requireValue(value.searchKeyEnv === null || typeof value.searchKeyEnv === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value.searchKeyEnv), 'TOOL_SETTINGS_CORRUPT', '搜索密钥来源不正确。')
      requireValue(value.searchSecret === null || typeof value.searchSecret === 'string' && value.searchSecret.length > 0 && value.searchKeyEnv === null, 'TOOL_SETTINGS_CORRUPT', '搜索密钥记录不正确。')
      return { version: 2, revision: Number(value.revision), settings: normalizeToolSettings(value.settings), searchKeyEnv: value.searchKeyEnv as string | null, searchSecret: value.searchSecret as string | null }
    } catch { throw new RpError('TOOL_SETTINGS_CORRUPT', '保存的工具设置无法读取，请检查数据库或从备份恢复。', 500) }
  }
  private save(value: Stored) { this.assets.setSetting(storageKey, JSON.parse(JSON.stringify(value)) as JsonValue) }
}
