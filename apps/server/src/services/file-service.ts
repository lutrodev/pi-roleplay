import sharp from 'sharp'
import { createHash } from 'node:crypto'
import type { ImageContent } from '@earendil-works/pi-ai'
import { parseCharacterCardFile, serializeCharacterCardV3, encodeCharacterCardV3Png } from '../../../../packages/rp-core/src/character/character-card.js'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { serializeLoreBookV3 } from '../../../../packages/rp-core/src/lore/activation.js'
import type { JsonObject } from '../../../../packages/rp-core/src/types.ts'
import type { AssetRepository } from '../storage/asset-repository.ts'
import { FileRepository, IMAGE_MIMES, imageMime, MAX_UPLOAD_BYTES } from '../storage/file-repository.ts'
import type { StoryRepository } from '../storage/story-repository.ts'

export class FileService {
  constructor(readonly files: FileRepository, readonly assets: AssetRepository, readonly stories: StoryRepository) {}

  async upload(bytes: Buffer, name: string, mimeType: string) {
    requireValue(bytes.length <= MAX_UPLOAD_BYTES, 'UPLOAD_TOO_LARGE', '单个附件不能超过 25 MB。')
    if (imageMime(bytes) || IMAGE_MIMES.has(mimeType)) {
      try {
        const metadata = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error', animated: false }).metadata()
        requireValue(metadata.width && metadata.height && metadata.width * metadata.height <= 40_000_000, 'IMAGE_TOO_LARGE', '图片尺寸过大。')
      } catch (error) { throw imageError(error) }
    }
    return this.files.save(bytes, name, mimeType)
  }

  async captureImage(bytes: Buffer, name: string) {
    const mimeType = imageMime(bytes)
    requireValue(mimeType, 'INVALID_IMAGE', '文件不是支持的图片格式。')
    const existing = this.files.findImage(createHash('sha256').update(bytes).digest('hex'), mimeType)
    if (existing) return this.files.read(existing.id).file
    return this.upload(bytes, name, mimeType)
  }

  async importCharacter(bytes: Buffer, name: string) {
    requireValue(bytes.length <= 20 * 1024 * 1024, 'UPLOAD_TOO_LARGE', '角色卡文件不能超过 20 MB。')
    let parsed: ReturnType<typeof parseCharacterCardFile>
    try { parsed = parseCharacterCardFile(bytes, name, { maxTextCharacters: 2_000_000 }) }
    catch (error) { throw importError(error, '角色卡文件无法导入，请检查格式和内容。') }
    if (!parsed.avatarBytes) return this.assets.importCharacter(parsed, null)
    const avatar = await cleanAvatar(Buffer.from(parsed.avatarBytes))
    return this.files.withFile(avatar, 'avatar.png', 'image/png', file => this.assets.importCharacter(parsed, file.id))
  }

  importLorebook(bytes: Buffer) {
    requireValue(bytes.length <= 2 * 1024 * 1024, 'UPLOAD_TOO_LARGE', '世界书文件不能超过 2 MB。')
    try { return this.assets.importLorebook(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
    catch (error) { throw importError(error, '世界书文件必须为有效的 JSON。') }
  }

  async updateAvatar(assetId: string, expectedRevision: number, bytes: Buffer | null) {
    if (bytes === null) return this.assets.setAvatar(assetId, expectedRevision, null)
    const asset = this.assets.get(assetId)
    requireValue(asset.revision === expectedRevision, 'REVISION_CONFLICT', '这份资料已经更新，请刷新后再保存。', 409)
    const format = asset.kind === 'persona' ? 'webp' : 'png'
    const avatar = await cleanAvatar(bytes, format)
    return this.files.withFile(avatar, `avatar.${format}`, `image/${format}`, file => this.assets.setAvatar(assetId, expectedRevision, file.id))
  }

  exportCharacter(id: string, format: 'json' | 'png') {
    const asset = this.assets.get(id, 'character')
    const books = this.assets.associatedLorebooks(id).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    const serialized = books.map(book => serializeLoreBookV3(book.data))
    const merged = serialized.length === 0 ? undefined : serialized.length === 1 ? serialized[0] : {
      name: `${asset.name} · 世界书`, extensions: {},
      ...(books.some(book => typeof book.data.scanDepth === 'number') ? { scan_depth: Math.max(...books.map(book => Number(book.data.scanDepth ?? 0))) } : {}),
      ...(books.some(book => typeof book.data.recursiveScanning === 'boolean') ? { recursive_scanning: books.every(book => book.data.recursiveScanning !== false) } : {}),
      entries: serialized.flatMap((book, index) => book.entries.map((entry: JsonObject) => ({ ...entry,
        id: `${books[index]!.id}:${String(entry.id)}`, insertion_order: index * 1000000 + Number(entry.insertion_order),
      }))),
    }
    const sourcePayload = asset.data.sourcePayload && typeof asset.data.sourcePayload === 'object' && !Array.isArray(asset.data.sourcePayload) ? asset.data.sourcePayload : undefined
    const payload = serializeCharacterCardV3(asset.data, { sourcePayload,
      characterBook: merged, maxTextCharacters: 2_000_000 })
    if (format === 'json') return { bytes: Buffer.from(JSON.stringify(payload, null, 2)), name: `${asset.name}.json`, mimeType: 'application/json' }
    const avatar = asset.avatarFileId ? this.files.read(asset.avatarFileId).bytes : undefined
    return { bytes: Buffer.from(encodeCharacterCardV3Png(payload, avatar)), name: `${asset.name}.png`, mimeType: 'image/png' }
  }

  attachmentsForRun(runId: string) {
    const run = this.stories.run(runId)
    const ids = [...new Set(this.stories.snapshot(run.storyId).messages.filter(message => message.runId === runId && message.role === 'user').flatMap(message => message.attachmentIds))]
    const records = ids.map(id => this.files.read(id))
    const images: ImageContent[] = records.filter(({ file }) => IMAGE_MIMES.has(file.mimeType)).map(({ file, bytes }) => ({
      type: 'image', mimeType: file.mimeType, data: bytes.toString('base64'),
    }))
    return { files: records.map(record => record.file), images }
  }
}

async function cleanAvatar(bytes: Buffer, format: 'png' | 'webp' = 'png') {
  requireValue(bytes.length > 0 && bytes.length <= 5 * 1024 * 1024, 'AVATAR_TOO_LARGE', '头像不能为空，且不能超过 5 MB。')
  requireValue(['image/png', 'image/jpeg', 'image/webp'].includes(imageMime(bytes) ?? ''), 'AVATAR_FORMAT_INVALID', '头像支持 PNG、JPEG 和 WebP。')
  try {
    return await sharp(bytes, { limitInputPixels: 16_777_216, failOn: 'error' }).rotate()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).toFormat(format).toBuffer()
  } catch (error) { throw imageError(error) }
}
function imageError(error: unknown) {
  return error instanceof RpError ? error : new RpError('INVALID_IMAGE', '图片无法解码或尺寸超过限制。')
}
function importError(error: unknown, message: string) {
  return error instanceof RpError ? error : new RpError('ASSET_IMPORT_FAILED', message, 400,
    error instanceof Error ? error.message : undefined)
}
