import { randomUUID } from 'node:crypto'
import { normalizeModelSelection, normalizeTaskSubagent, subagentNameKey, type SubagentCatalog, type TaskSubagent } from '../../../../packages/rp-core/src/agents/catalog.ts'
import { DEFAULT_SUBAGENTS } from '../../../../packages/rp-core/src/seeds/subagents.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { JsonValue } from '../../../../packages/rp-core/src/types.ts'
import type { ModelRegistry } from '../runtime/models.ts'
import type { AssetRepository } from '../storage/asset-repository.ts'

const KEY = 'subagents.catalog'

/** SQLite owns the small single-user catalog. Deleting all examples does not reseed them. */
export class SubagentService {
  constructor(readonly assets: AssetRepository, readonly models: ModelRegistry) {}

  snapshot(): SubagentCatalog {
    return this.assets.database.transaction(() => {
      const value = this.assets.getSetting(KEY)
      if (value === undefined) {
        const now = new Date().toISOString()
        const seed: SubagentCatalog = { version: 1, writer: { revision: 1, route: { kind: 'inherit' } },
          subagents: DEFAULT_SUBAGENTS.map(input => ({ ...normalizeTaskSubagent(input), id: randomUUID(), revision: 1, createdAt: now, updatedAt: now })) }
        this.save(seed); return seed
      }
      try {
        requireValue(value && typeof value === 'object' && !Array.isArray(value) && value.version === 1 && Array.isArray(value.subagents) && value.subagents.length <= 32, 'INVALID_CATALOG', '子代理目录结构不正确。')
        const catalog = value as unknown as SubagentCatalog
        requireValue(catalog.writer && Number.isSafeInteger(catalog.writer.revision) && catalog.writer.revision >= 1, 'INVALID_CATALOG', 'Writer 配置版本不正确。')
        normalizeModelSelection(catalog.writer.route)
        const ids = new Set<string>(), names = new Set<string>()
        for (const item of catalog.subagents) {
          const { id, revision, createdAt, updatedAt, ...body } = item
          requireValue(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) && !ids.has(id) && Number.isSafeInteger(revision) && revision >= 1 && typeof createdAt === 'string' && typeof updatedAt === 'string' && Number.isFinite(Date.parse(createdAt)) && Number.isFinite(Date.parse(updatedAt)), 'INVALID_CATALOG', '子代理记录不完整。')
          normalizeTaskSubagent(body)
          requireValue(!names.has(subagentNameKey(item.name)), 'INVALID_CATALOG', '子代理名称重复。')
          ids.add(id); names.add(subagentNameKey(item.name))
        }
        return structuredClone(catalog)
      } catch (error) { throw new RpError('SUBAGENT_CATALOG_INVALID', '子代理配置已损坏，请检查数据库或从备份恢复。', 500, error instanceof Error ? error.message : undefined) }
    })
  }

  create(input: unknown) {
    const body = normalizeTaskSubagent(input)
    this.validateRoute(body.route)
    return this.assets.database.transaction(() => {
      const catalog = this.snapshot()
      requireValue(catalog.subagents.length < 32, 'SUBAGENT_LIMIT', '最多保存 32 个任务子代理。')
      this.uniqueName(catalog, body.name)
      const now = new Date().toISOString()
      const created: TaskSubagent = { ...body, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now }
      catalog.subagents.push(created); this.save(catalog); return created
    })
  }

  update(id: string, expectedRevision: number, input: unknown) {
    return this.assets.database.transaction(() => {
      const catalog = this.snapshot(), current = this.find(catalog, id, expectedRevision)
      const body = normalizeTaskSubagent(input, current.enabled)
      this.validateRoute(body.route); this.uniqueName(catalog, body.name, id)
      const updated = { ...current, ...body, revision: current.revision + 1, updatedAt: new Date().toISOString() }
      catalog.subagents[catalog.subagents.indexOf(current)] = updated; this.save(catalog); return updated
    })
  }

  setEnabled(id: string, expectedRevision: number, enabled: boolean) {
    requireValue(typeof enabled === 'boolean', 'INVALID_SUBAGENT', '子代理启用状态不正确。')
    return this.assets.database.transaction(() => {
      const catalog = this.snapshot(), current = this.find(catalog, id, expectedRevision)
      if (current.enabled === enabled) return current
      current.enabled = enabled; current.revision++; current.updatedAt = new Date().toISOString(); this.save(catalog); return current
    })
  }

  remove(id: string, expectedRevision: number) {
    return this.assets.database.transaction(() => {
      const catalog = this.snapshot(), current = this.find(catalog, id, expectedRevision)
      catalog.subagents.splice(catalog.subagents.indexOf(current), 1); this.save(catalog); return { id }
    })
  }

  updateWriter(expectedRevision: number, input: unknown) {
    const route = normalizeModelSelection(input); this.validateRoute(route)
    return this.assets.database.transaction(() => {
      const catalog = this.snapshot()
      requireValue(catalog.writer.revision === expectedRevision, 'REVISION_CONFLICT', 'Writer 配置已经更新，请刷新后再保存。', 409)
      catalog.writer = { revision: expectedRevision + 1, route }; this.save(catalog); return catalog.writer
    })
  }

  private validateRoute(route: ReturnType<typeof normalizeModelSelection>) { if (route.kind === 'fixed') this.models.resolve(route) }
  private find(catalog: SubagentCatalog, id: string, expectedRevision: number) {
    requireValue(id !== 'writer', 'WRITER_FIXED', '固定 Writer 只能修改模型路由，不能删除、停用或更改工作指令。')
    const item = catalog.subagents.find(item => item.id === id)
    requireValue(item, 'SUBAGENT_NOT_FOUND', '这个任务子代理已不存在。', 404)
    requireValue(item.revision === expectedRevision, 'REVISION_CONFLICT', '子代理已经更新，请刷新后再保存。', 409)
    return item
  }
  private uniqueName(catalog: SubagentCatalog, name: string, ignoredId?: string) { requireValue(!catalog.subagents.some(item => item.id !== ignoredId && subagentNameKey(item.name) === subagentNameKey(name)), 'SUBAGENT_NAME_CONFLICT', '已经有同名任务子代理，请使用不同名称。', 409) }
  private save(catalog: SubagentCatalog) { this.assets.setSetting(KEY, JSON.parse(JSON.stringify(catalog)) as JsonValue) }
}
