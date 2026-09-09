import { createHash } from 'node:crypto'
import { objectInput } from '../../../../packages/rp-core/src/input.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { JsonValue } from '../../../../packages/rp-core/src/types.ts'
import { parseModelConfig } from '../config.ts'
import { ModelRegistry, type ModelRegistration } from '../runtime/models.ts'
import type { AssetRepository } from '../storage/asset-repository.ts'
import { CredentialCipher } from '../storage/credential-cipher.ts'
import { checkModel, discoverModels, inspectionError, validateConnection, type ModelCheck, type ModelConnection } from './model-inspection.ts'
import { ModelDiscoveryCache, metadataKey, sameConnection, storedMetadata, type StoredMetadata } from './model-discovery-cache.ts'
import { resolveMetadata, type ModelIdentity } from '../runtime/model-metadata.ts'

const storageKey = 'models.catalog'
interface Catalog { version: 3; revision: number; registrations: ModelRegistration[]; labels: Record<string, string>; secrets: Record<string, string>; connections: Record<string, ModelConnection & { keyEnv: string }>; metadata: StoredMetadata }
interface StoredCheck extends ModelCheck { fingerprint: string }
export interface ProviderInput { id: string; label: string; apiKey?: string; clearKey?: boolean; connection?: ModelConnection; discoveryId?: string; models: Omit<ModelRegistration, 'keyEnv' | 'provider'>[] }

/** Authenticated Web management; database backups contain authenticated ciphertext, never raw API keys. */
export class ModelCatalogService {
  readonly models: ModelRegistry
  private readonly cipher: CredentialCipher
  private readonly discoveries: ModelDiscoveryCache
  private credentials = new Map<string, string>()
  private inspections = new Set<AbortController>()
  private checking = new Set<string>()
  private closed = false
  constructor(readonly assets: AssetRepository, initial: ModelRegistration[], sessionKey: Buffer,
    readonly options: NonNullable<ConstructorParameters<typeof ModelRegistry>[1]> = {}, readonly busy: () => boolean = () => false) {
    this.cipher = new CredentialCipher(sessionKey, 'pi-roleplay/model-credentials/v1\0')
    this.discoveries = new ModelDiscoveryCache(sessionKey)
    const saved = assets.getSetting(storageKey)
    const catalog = saved === undefined ? this.upgrade({ version: 1, revision: 1, registrations: structuredClone(initial), labels: {}, secrets: {} }) : this.read()
    this.credentials = this.decode(catalog)
    this.models = new ModelRegistry(catalog.registrations, { ...this.registryOptions(catalog), env: name => this.credentials.get(name) ?? (options?.env ?? (key => process.env[key]))(name) })
    if (saved === undefined || (saved as { version?: number }).version !== 3) this.save(catalog)
  }
  snapshot() {
    const catalog = this.read(), registrations = this.models.registrations(), configured = this.models.list(), checks = this.checks()
    return { revision: catalog.revision, providers: Object.keys(catalog.labels).map(id => ({
      id, label: catalog.labels[id] ?? id, keyStored: Boolean(catalog.secrets[id]),
      connection: { api: catalog.connections[id]!.api, baseUrl: catalog.connections[id]!.baseUrl },
      credentialConfigured: Boolean(this.key(catalog.connections[id]!.keyEnv)),
      models: registrations.filter(model => model.provider === id).map(({ provider: _provider, keyEnv: _key, ...model }) => ({ ...model,
        configured: configured.find(item => item.provider === id && item.model === model.model)?.configured ?? false,
        effective: configured.find(item => item.provider === id && item.model === model.model)!,
        check: this.visibleCheck(checks[routeKey(id, model.model)], catalog.registrations.find(item => item.provider === id && item.model === model.model)!),
      })),
    })) }
  }
  /** Local metadata lookup only: no credentials, network calls, or model generation. */
  previewMetadata(input: { provider: string; model: string; connection: unknown; discoveryId?: string }) {
    const connection = validateConnection(input.connection)
    const metadata = input.discoveryId ? this.discoveries.read(input.discoveryId, connection).find(item => item.model === input.model)?.metadata
      : storedMetadata(this.read().metadata, { ...connection, ...input })
    return new ModelRegistry([{ ...connection, provider: input.provider, model: input.model, keyEnv: 'MODEL_PREVIEW' }], {
      env: () => undefined, metadata: () => metadata,
    }).list()[0]!
  }
  update(expectedRevision: number, input: unknown, create = false) {
    objectInput(input)
    requireValue(Object.keys(input).every(key => ['id', 'label', 'models', 'apiKey', 'clearKey', 'connection', 'discoveryId'].includes(key)) && typeof input.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.id), 'MODEL_CONFIG_INVALID', '提供方标识需要小写字母、数字、点、下划线或连字符。')
    requireValue(input.discoveryId === undefined || typeof input.discoveryId === 'string' && input.discoveryId.length <= 100, 'MODEL_CONFIG_INVALID', '模型识别记录不正确。')
    requireValue(typeof input.label === 'string' && input.label.trim().length > 0 && input.label.length <= 200, 'MODEL_CONFIG_INVALID', '提供方名称不能为空，最多 200 字符。')
    requireValue(Array.isArray(input.models) && input.models.length <= 64, 'MODEL_CONFIG_INVALID', '每个连接最多添加 64 个模型。')
    requireValue(input.apiKey === undefined || typeof input.apiKey === 'string' && input.apiKey.trim().length > 0 && input.apiKey.length <= 8192 && !/[\r\n\0]/.test(input.apiKey), 'MODEL_CONFIG_INVALID', 'API 密钥格式不正确。')
    requireValue(input.clearKey === undefined || typeof input.clearKey === 'boolean', 'MODEL_CONFIG_INVALID', '移除密钥选项不正确。')
    requireValue(!input.clearKey || input.apiKey === undefined, 'MODEL_CONFIG_INVALID', '不能同时替换和移除密钥。')
    const id = input.id, label = input.label.trim(), values = input.models, apiKey = input.apiKey as string | undefined
    return this.mutate(expectedRevision, current => {
      const managedKey = envName(id), old = current.registrations.filter(model => model.provider === id)
      requireValue(create ? !Object.hasOwn(current.labels, id) : Object.hasOwn(current.labels, id), create ? 'PROVIDER_EXISTS' : 'PROVIDER_NOT_FOUND', create ? '这个提供方标识已存在，请使用编辑或换一个标识。' : '这个提供方不存在，请刷新页面。', 409)
      requireValue(!create || Object.keys(current.labels).length < 64, 'MODEL_CONFIG_INVALID', '最多添加 64 个服务连接。')
      let connection: ModelConnection | undefined = current.connections[id]
      if (input.connection !== undefined) {
        objectInput(input.connection)
        const unchanged = connection && input.connection.api === connection.api && input.connection.baseUrl === connection.baseUrl && Object.keys(input.connection).every(key => ['api', 'baseUrl'].includes(key))
        connection = unchanged ? { api: connection!.api, baseUrl: connection!.baseUrl } : validateConnection(input.connection)
      }
      requireValue(values.length > 0 || connection, 'MODEL_CONFIG_INVALID', '请先填写连接协议和地址。')
      const sharedKey = apiKey || input.clearKey || current.secrets[id] ? managedKey : current.connections[id]?.keyEnv ?? old[0]?.keyEnv ?? managedKey
      const registrations = values.map(value => {
        objectInput(value)
        requireValue(!('keyEnv' in value) && !('provider' in value) && !('configured' in value) && !('check' in value), 'MODEL_CONFIG_INVALID', '模型字段包含不支持的配置。')
        const keyEnv = apiKey || input.clearKey || current.secrets[id] ? managedKey : old.find(item => item.model === value.model)?.keyEnv ?? sharedKey
        return { ...value, api: value.api ?? connection?.api, baseUrl: value.baseUrl ?? connection?.baseUrl, provider: id, keyEnv }
      })
      const parsed = parseModelConfig({ models: [...current.registrations.filter(model => model.provider !== id), ...registrations] })
      const secrets = { ...current.secrets }
      if (apiKey) secrets[id] = this.cipher.encrypt(id, apiKey.trim())
      else if (input.clearKey) delete secrets[id]
      const first = parsed.models.find(model => model.provider === id)
      const resolved = connection ?? (first?.baseUrl ? first : new ModelRegistry(parsed.models, this.registryOptions(current)).registrations().find(model => model.provider === id))
      const defaults = { api: resolved?.api, baseUrl: resolved!.baseUrl! }
      const changedKey = input.clearKey || apiKey && apiKey.trim() !== this.key(current.connections[id]?.keyEnv ?? '')
      const metadata = Object.fromEntries(Object.entries(current.metadata).filter(([key, entry]) => parsed.models.some(model => metadataKey(model) === key && sameConnection(model, entry.connection) && !(changedKey && model.provider === id))))
      if (input.discoveryId) {
        const discovered = this.discoveries.forSave(input.discoveryId as string, apiKey?.trim() ?? this.key(sharedKey) ?? '')
        const matching = parsed.models.filter(model => model.provider === id && sameConnection(model, discovered.connection))
        requireValue(matching.length > 0, 'MODEL_DISCOVERY_EXPIRED', '连接已变更，请重新获取模型信息。', 409)
        for (const model of matching) {
          const found = discovered.models.find(item => item.model === model.model)
          if (found) metadata[metadataKey(model)] = { connection: discovered.connection, value: found.metadata ?? {} }
        }
      }
      return { ...current, registrations: parsed.models, labels: { ...current.labels, [id]: label }, secrets,
        metadata, connections: { ...current.connections, [id]: { api: defaults.api, baseUrl: defaults.baseUrl, keyEnv: sharedKey } } }
    })
  }
  remove(expectedRevision: number, provider: string) {
    return this.mutate(expectedRevision, current => {
      requireValue(Object.hasOwn(current.labels, provider), 'PROVIDER_NOT_FOUND', '这个提供方不存在。', 404)
      const { [provider]: _secret, ...secrets } = current.secrets, { [provider]: _label, ...labels } = current.labels
      const { [provider]: _connection, ...connections } = current.connections
      const registrations = current.registrations.filter(model => model.provider !== provider)
      return { ...current, registrations, secrets, labels, connections, metadata: Object.fromEntries(Object.entries(current.metadata).filter(([key]) => registrations.some(model => metadataKey(model) === key))) }
    })
  }
  private mutate(expectedRevision: number, operation: (current: Catalog) => Catalog) {
    this.assets.database.transaction(() => {
      requireValue(!this.busy(), 'MODEL_CONFIG_BUSY', '有模型任务正在运行，请等待回复、摘要和回复选项完成后修改模型配置。', 409)
      const current = this.read()
      requireValue(current.revision === expectedRevision, 'REVISION_CONFLICT', '模型配置已经更新，请刷新后再保存。', 409)
      const next = { ...operation(current), revision: current.revision + 1 }, credentials = this.decode(next)
      // Validate before saving; request routing is replaced atomically while there are no in-flight calls.
      new ModelRegistry(next.registrations, { ...this.registryOptions(next), env: name => credentials.get(name) ?? this.options?.env?.(name) ?? process.env[name] })
      this.save(next); this.credentials = credentials; this.models.replace(next.registrations, this.registryOptions(next))
    })
    return this.snapshot()
  }
  private read(): Catalog {
    const value = this.assets.getSetting(storageKey)
    try {
      objectInput(value)
      requireValue([1, 2, 3].includes(Number(value.version)) && Number.isSafeInteger(value.revision) && Number(value.revision) > 0, 'MODEL_CATALOG_CORRUPT', '模型配置版本不正确。')
      objectInput(value.labels); objectInput(value.secrets)
      requireValue(Object.values(value.labels).every(item => typeof item === 'string') && Object.values(value.secrets).every(item => typeof item === 'string'), 'MODEL_CATALOG_CORRUPT', '模型配置不正确。')
      return this.upgrade(value)
    } catch { throw new RpError('MODEL_CATALOG_CORRUPT', '保存的模型配置无法读取，请使用匹配的备份恢复。', 500) }
  }
  private upgrade(value: Record<string, unknown>): Catalog {
    const registrations = parseModelConfig({ models: value.registrations }).models
    const labels = { ...value.labels as Record<string, string> }, connections: Catalog['connections'] = {}
    if (value.version === 2 || value.version === 3) {
      objectInput(value.connections)
      for (const [id, raw] of Object.entries(value.connections)) {
        objectInput(raw)
        requireValue(typeof raw.keyEnv === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(raw.keyEnv), 'MODEL_CATALOG_CORRUPT', '连接密钥引用不正确。')
        // Stored v1 URLs must survive migration byte-for-byte. New edits use stricter input validation.
        requireValue(typeof raw.baseUrl === 'string' && (raw.api === undefined || ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(String(raw.api))), 'MODEL_CATALOG_CORRUPT', '连接配置不正确。')
        connections[id] = { api: raw.api as ModelConnection['api'], baseUrl: raw.baseUrl, keyEnv: raw.keyEnv }
      }
      requireValue(Object.keys(labels).every(id => connections[id]) && registrations.every(item => Object.hasOwn(labels, item.provider)), 'MODEL_CATALOG_CORRUPT', '模型与连接记录不一致。')
    } else {
      for (const model of new ModelRegistry(registrations, this.options).registrations()) {
        labels[model.provider] ??= model.provider
        connections[model.provider] ??= { api: model.api, baseUrl: model.baseUrl!, keyEnv: model.keyEnv }
      }
    }
    const metadata = value.version === 3 ? value.metadata : {}
    objectInput(metadata)
    for (const entry of Object.values(metadata)) { objectInput(entry); objectInput(entry.connection); objectInput(entry.value) }
    return { version: 3, revision: Number(value.revision), registrations, labels, connections, metadata: metadata as unknown as StoredMetadata, secrets: value.secrets as Record<string, string> }
  }
  private registryOptions(catalog: Catalog) {
    return { ...this.options, metadata: (route: ModelIdentity) => storedMetadata(catalog.metadata, route), providerLabel: (id: string) => catalog.labels[id] ?? id }
  }
  private key(name: string) { return this.credentials.get(name) ?? (this.options.env ?? (key => process.env[key]))(name) }
  private fingerprint(registration: ModelRegistration) {
    const { label: _label, ...configuration } = registration
    const { label: _detectedLabel, ...metadata } = storedMetadata(this.read().metadata, registration) ?? {}
    return createHash('sha256').update(JSON.stringify([configuration, metadata])).update('\0').update(this.key(registration.keyEnv) ?? '').digest('hex')
  }
  private checks(): Record<string, StoredCheck> {
    const value = this.assets.getSetting('models.checks') ?? {}
    objectInput(value)
    return value as unknown as Record<string, StoredCheck>
  }
  private visibleCheck(check: StoredCheck | undefined, registration: ModelRegistration) {
    if (!check || check.fingerprint !== this.fingerprint(registration)) return null
    const { fingerprint: _fingerprint, ...visible } = check; return visible
  }
  async discover(input: unknown) {
    objectInput(input)
    requireValue(Object.keys(input).every(key => ['provider', 'apiKey', 'connection'].includes(key)), 'MODEL_CONFIG_INVALID', '连接字段包含不支持的配置。')
    const connection = validateConnection(input.connection), provider = input.provider
    requireValue(provider === undefined || typeof provider === 'string' && Object.hasOwn(this.read().labels, provider), 'PROVIDER_NOT_FOUND', '这个提供方不存在，请刷新页面。', 404)
    requireValue(input.apiKey === undefined || typeof input.apiKey === 'string' && input.apiKey.trim().length > 0 && input.apiKey.length <= 8192 && !/[\r\n\0]/.test(input.apiKey), 'MODEL_CONFIG_INVALID', 'API 密钥格式不正确。')
    const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : typeof provider === 'string' ? this.key(this.read().connections[provider]!.keyEnv) : undefined
    requireValue(key, 'MODEL_KEY_MISSING', '请先填写 API 密钥。')
    return this.inspection(async signal => { try {
      const result = await discoverModels(connection, key, (this.options.fetch ?? fetch) as typeof fetch, signal)
      return { ...result, discoveryId: this.discoveries.add(connection, key, result.models), models: result.models.map(model => ({ ...model,
        effective: resolveMetadata({ ...connection, provider: typeof provider === 'string' ? provider : 'preview', model: model.model, keyEnv: 'MODEL_PREVIEW' }, model.metadata),
      })) }
    } catch (error) { throw inspectionError(error) } })
  }
  async test(expectedRevision: number, provider: string, model: string) {
    const catalog = this.read(), registration = catalog.registrations.find(item => item.provider === provider && item.model === model)
    requireValue(catalog.revision === expectedRevision, 'REVISION_CONFLICT', '模型配置已经更新，请刷新后再测试。', 409)
    requireValue(registration, 'MODEL_NOT_CONFIGURED', '这个模型尚未配置。', 404)
    const key = this.key(registration.keyEnv), id = routeKey(provider, model)
    requireValue(key, 'MODEL_KEY_MISSING', '请先填写 API 密钥。')
    requireValue(!this.checking.has(id), 'MODEL_TEST_BUSY', '这个模型正在测试，请稍候。', 409)
    const fingerprint = this.fingerprint(registration); this.checking.add(id)
    try {
      return await this.inspection(async signal => {
        const result = await checkModel(registration, key, this.registryOptions(catalog), signal)
        if (!this.closed) {
          const current = this.read().registrations.find(item => item.provider === provider && item.model === model)
          if (current && this.fingerprint(current) === fingerprint) this.assets.setSetting('models.checks', { ...this.checks(), [id]: { ...result, fingerprint } } as unknown as JsonValue)
        }
        return result
      })
    } finally { this.checking.delete(id) }
  }
  private async inspection<T>(operation: (signal: AbortSignal) => Promise<T>) {
    requireValue(!this.closed, 'MODEL_TEST_BUSY', '服务正在关闭，请稍后重试。', 503)
    requireValue(this.inspections.size < 2, 'MODEL_TEST_BUSY', '已有模型请求正在检查，请稍候。', 409)
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('timeout')), 15000)
    this.inspections.add(controller)
    try { return await operation(controller.signal) } finally { clearTimeout(timer); this.inspections.delete(controller) }
  }
  close() { this.closed = true; this.discoveries.clear(); for (const controller of this.inspections) controller.abort() }
  private save(value: Catalog) { this.assets.setSetting(storageKey, JSON.parse(JSON.stringify(value)) as JsonValue) }
  private decode(value: Catalog) {
    try {
      return new Map(Object.entries(value.secrets).map(([provider, encrypted]) => [envName(provider), this.cipher.decrypt(provider, encrypted)]))
    } catch { throw new RpError('MODEL_KEY_DECRYPT_FAILED', '模型密钥无法解密；恢复备份时必须同时使用原 Cookie 密钥文件。', 500) }
  }
}
function envName(provider: string) { return 'RP_WEB_KEY_' + createHash('sha256').update(provider).digest('hex').slice(0, 24).toUpperCase() }
function routeKey(provider: string, model: string) { return JSON.stringify([provider, model]) }
