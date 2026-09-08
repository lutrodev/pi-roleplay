import { createHash, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { ASSET_LIMITS, countText, countCharacterText, normalizeAsset } from '../../../../packages/rp-core/src/assets/normalize.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { normalizeLoreBook } from '../../../../packages/rp-core/src/lore/activation.js'
import { convertMvuImport } from '../../../../packages/rp-core/src/mvu/convert.js'
import { DEFAULT_PRESET } from '../../../../packages/rp-core/src/seeds/preset.js'
import { DEFAULT_WRITING_STYLE } from '../../../../packages/rp-core/src/seeds/writing-style.js'
import { DEFAULT_PERSONA } from '../../../../packages/rp-core/src/seeds/persona.ts'
import type { parseCharacterCardFile } from '../../../../packages/rp-core/src/character/character-card.js'
import type { AssetKind, AssetRecord, JsonObject, JsonValue } from '../../../../packages/rp-core/src/types.ts'
import type { AppDatabase } from './database.ts'
import { assets, files, settings } from './schema.ts'

type ImportedCharacter = ReturnType<typeof parseCharacterCardFile>

export class AssetRepository {
  constructor(readonly database: AppDatabase) {}

  get(id: string, kind?: AssetKind): AssetRecord {
    const asset = this.database.orm.select().from(assets).where(eq(assets.id, id)).get()
    if (!asset || (kind && asset.kind !== kind)) throw new RpError('ASSET_NOT_FOUND', '这份资料已不存在。', 404)
    return asset
  }

  resolve(id: string | undefined, kind: AssetKind): AssetRecord | null {
    if (!id) return null
    const asset = this.database.orm.select().from(assets).where(and(eq(assets.id, id), eq(assets.kind, kind))).get()
    return asset ?? null
  }

  list(kind: AssetKind, query = ''): AssetRecord[] {
    const rows = this.database.orm.select().from(assets).where(eq(assets.kind, kind)).orderBy(...this.order(kind)).all()
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return rows.filter(row => !normalizedQuery || row.name.toLocaleLowerCase().includes(normalizedQuery))
  }

  catalog(kind: AssetKind, query = '', offset = 0, limit = 30) {
    requireValue(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_LIMIT', '资料列表位置或大小不正确。')
    const rows = this.database.orm.select({ id: assets.id, kind: assets.kind, name: assets.name, revision: assets.revision,
      avatarFileId: assets.avatarFileId, sourceCharacterId: assets.sourceCharacterId, createdAt: assets.createdAt, updatedAt: assets.updatedAt,
      description: sql<string>`substr(coalesce(json_extract(${assets.data}, '$.description'), ''), 1, 240)`,
      contentCharacters: sql<number | null>`CASE WHEN ${assets.kind} = 'writingStyle' THEN length(coalesce(json_extract(${assets.data}, '$.content'), '')) ELSE NULL END`,
    }).from(assets).where(eq(assets.kind, kind)).orderBy(...this.order(kind)).all()
    const normalized = query.trim().toLocaleLowerCase(), matched = normalized ? rows.filter(row => row.name.toLocaleLowerCase().includes(normalized)) : rows
    return { assets: matched.slice(offset, offset + limit), total: matched.length, nextOffset: offset + limit < matched.length ? offset + limit : null }
  }

  create(kind: AssetKind, input: unknown): AssetRecord {
    const id = randomUUID()
    const data = normalizeAsset(kind, input, id)
    return this.insert({ id, kind, data })
  }

  update(id: string, expectedRevision: number, input: unknown): AssetRecord {
    return this.database.transaction(() => {
      const current = this.get(id)
      requireValue(current.revision === expectedRevision, 'REVISION_CONFLICT', '这份资料已经更新，请刷新后再保存。', 409)
      let data = normalizeAsset(current.kind, input, id, true)
      if (current.kind === 'character') {
        data = { ...structuredClone(current.data), ...data }
        const quarantined = Array.isArray(current.data.quarantinedPrompts) ? current.data.quarantinedPrompts : []
        const knownPaths = new Set(quarantined.flatMap(item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.path === 'string' && typeof item.value === 'string' ? [item.path] : []))
        requireValue((data.acceptedPromptPaths as string[]).every(path => knownPaths.has(path)), 'INVALID_REQUEST', '所选提示内容已不存在，请重新选择。')
      }
      requireValue((current.kind === 'character' ? countCharacterText(data) : countText(data)) <= ASSET_LIMITS[current.kind], 'LIMIT_EXCEEDED', '完整资料内容超过了允许的长度。')
      this.database.orm.update(assets).set({ name: String(data.name), data, revision: current.revision + 1, updatedAt: new Date().toISOString() }).where(and(eq(assets.id, id), eq(assets.revision, expectedRevision))).run()
      return this.get(id)
    })
  }

  remove(id: string, expectedRevision: number) {
    return this.database.transaction(() => {
      const asset = this.get(id)
      requireValue(asset.revision === expectedRevision, 'REVISION_CONFLICT', '这份资料已经更新，请刷新后再删除。', 409)
      this.database.orm.delete(assets).where(eq(assets.id, id)).run()
      return asset
    })
  }

  associatedLorebooks(characterId: string): AssetRecord[] {
    return this.database.orm.select().from(assets).where(and(eq(assets.kind, 'lorebook'), eq(assets.sourceCharacterId, characterId))).all()
  }

  setAvatar(id: string, expectedRevision: number, fileId: string | null) {
    return this.database.transaction(() => {
      const asset = this.get(id)
      requireValue(asset.kind === 'character' || asset.kind === 'persona', 'INVALID_REQUEST', '只有角色和人设可以设置头像。')
      requireValue(asset.revision === expectedRevision, 'REVISION_CONFLICT', '这份资料已经更新，请刷新后再保存。', 409)
      if (fileId) requireValue(this.database.orm.select().from(files).where(eq(files.id, fileId)).get(), 'FILE_NOT_FOUND', '头像文件已不存在。', 404)
      this.database.orm.update(assets).set({ avatarFileId: fileId, revision: asset.revision + 1, updatedAt: new Date().toISOString() }).where(eq(assets.id, id)).run()
      return this.get(id)
    })
  }

  removeCharacter(id: string, expectedRevision: number, removeAssociated = true) {
    const card = this.get(id, 'character')
    const associated = removeAssociated ? this.associatedLorebooks(id) : []
    this.remove(card.id, expectedRevision)
    const failures: { id: string; name: string }[] = []
    for (const book of associated) {
      try { this.remove(book.id, book.revision) }
      catch { failures.push({ id: book.id, name: book.name }) }
    }
    return { removedId: id, associatedFailures: failures }
  }

  importCharacter(parsed: ImportedCharacter, avatarFileId: string | null = null) {
    return this.database.transaction(() => {
      const existing = this.database.orm.select().from(assets).where(and(eq(assets.kind, 'character'), eq(assets.sourceHash, parsed.sourceHash))).get()
      if (existing) throw new RpError('DUPLICATE_ASSET', '这张角色卡已经导入。', 409, { assetId: existing.id })
      const converted = convertMvuImport(parsed)
      const id = randomUUID()
      const data = structuredClone(converted.character) as unknown as JsonObject
      data.sourcePayload = structuredClone(converted.sourcePayload) as JsonObject
      data.quarantinedPrompts = structuredClone(converted.quarantinedPrompts) as JsonValue[]
      data.acceptedPromptPaths = []
      requireValue(countCharacterText(data) <= ASSET_LIMITS.character, 'LIMIT_EXCEEDED', '完整角色卡超过了允许的长度。')
      const card = this.insert({ id, kind: 'character', data, sourceHash: parsed.sourceHash, avatarFileId })
      const rawBook = converted.character.characterBook
      let lorebook: AssetRecord | null = null
      if (rawBook && typeof rawBook === 'object') {
        const bookId = randomUUID()
        const book = normalizeLoreBook(rawBook, bookId)
        normalizeAsset('lorebook', book, bookId)
        if (book.entries.length > 0) lorebook = this.insert({
          id: bookId, kind: 'lorebook', sourceCharacterId: id,
          data: { ...book, name: `${card.name} · 世界书` } as unknown as JsonObject,
        })
      }
      return { card, lorebook }
    })
  }

  importLorebook(input: unknown): AssetRecord {
    requireValue(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_REQUEST', '世界书文件必须包含资料对象。')
    requireValue(Buffer.byteLength(JSON.stringify(input), 'utf8') <= 2 * 1024 * 1024, 'LIMIT_EXCEEDED', '世界书文件不能超过 2 MB。')
    const sourceHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    return this.database.transaction(() => {
      const existing = this.database.orm.select().from(assets).where(and(eq(assets.kind, 'lorebook'), eq(assets.sourceHash, sourceHash))).get()
      if (existing) throw new RpError('DUPLICATE_ASSET', '这本世界书已经导入。', 409, { assetId: existing.id })
      const id = randomUUID()
      const data = normalizeAsset('lorebook', normalizeLoreBook(input, id), id)
      return this.insert({ id, kind: 'lorebook', data, sourceHash })
    })
  }

  ensureDefaults() {
    return this.database.transaction(() => {
      const result: { persona: string; preset: string; writingStyle: string } = { persona: '', preset: '', writingStyle: '' }
      for (const kind of ['persona', 'preset', 'writingStyle'] as const) {
        const key = `default.${kind}`
        const preferred = this.getSetting(key)
        let selected = this.list(kind).find(item => item.id === preferred) ?? this.list(kind)[0]
        if (!selected) selected = this.create(kind, kind === 'persona' ? DEFAULT_PERSONA : kind === 'preset' ? DEFAULT_PRESET : DEFAULT_WRITING_STYLE)
        this.setSetting(key, selected.id)
        result[kind] = selected.id
      }
      return result
    })
  }

  setDefault(kind: 'persona' | 'preset' | 'writingStyle', id: string) {
    this.get(id, kind)
    this.setSetting(`default.${kind}`, id)
  }

  getSetting(key: string): JsonValue | undefined {
    return this.database.orm.select().from(settings).where(eq(settings.key, key)).get()?.value
  }

  private order(kind: AssetKind) {
    return kind === 'character' || kind === 'lorebook'
      ? [desc(assets.createdAt), desc(sql`${assets}.rowid`)] : [asc(assets.name), asc(assets.id)]
  }

  setSetting(key: string, value: JsonValue) {
    this.database.orm.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run()
  }

  private insert(input: { id: string; kind: AssetKind; data: JsonObject; sourceHash?: string; sourceCharacterId?: string; avatarFileId?: string | null }): AssetRecord {
    const now = new Date().toISOString()
    requireValue(typeof input.data.name === 'string' && input.data.name.trim().length > 0, 'INVALID_REQUEST', '请填写资料名称。')
    return this.database.orm.insert(assets).values({
      id: input.id, kind: input.kind, name: input.data.name, revision: 1, data: input.data,
      sourceHash: input.sourceHash ?? null, sourceCharacterId: input.sourceCharacterId ?? null, avatarFileId: input.avatarFileId ?? null,
      createdAt: now, updatedAt: now,
    }).returning().get()
  }
}
