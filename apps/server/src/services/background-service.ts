import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import sharp from 'sharp'
import { BACKGROUND_INTENSITY, BACKGROUND_PRESETS, MAX_BACKGROUNDS, MAX_BACKGROUND_UPLOAD_BYTES, type BackgroundChoice, type BackgroundSnapshot } from '../../../../packages/protocol/src/backgrounds.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { AssetRepository } from '../storage/asset-repository.ts'
import { imageMime } from '../storage/file-repository.ts'
import { backgroundImages } from '../storage/schema.ts'
import { builtinBackgroundContent } from '../builtin-backgrounds.ts'

const key = 'app.background'
const metadata = { id: backgroundImages.id, name: backgroundImages.name, width: backgroundImages.width, height: backgroundImages.height, size: backgroundImages.size, createdAt: backgroundImages.createdAt }
type StoredBackground = BackgroundChoice & { version: 1; revision: number }

/** Image bytes, library edits and active selection commit together and travel with a DB backup. */
export class BackgroundService {
  constructor(readonly assets: AssetRepository) {}
  snapshot(): BackgroundSnapshot {
    return this.assets.database.transaction(() => {
      const images = this.assets.database.orm.select(metadata).from(backgroundImages).orderBy(desc(backgroundImages.createdAt), backgroundImages.id).all()
      const stored = this.assets.getSetting(key)
      if (stored === undefined) return { revision: 1, selectedId: null, intensity: BACKGROUND_INTENSITY.default, images }
      requireValue(stored && typeof stored === 'object' && !Array.isArray(stored) && Object.keys(stored).sort().join(',') === 'intensity,revision,selectedId,version' && stored.version === 1 && Number.isSafeInteger(stored.revision) && Number(stored.revision) > 0 && Number.isInteger(stored.intensity) && Number(stored.intensity) >= BACKGROUND_INTENSITY.min && Number(stored.intensity) <= BACKGROUND_INTENSITY.max && (stored.selectedId === null || BACKGROUND_PRESETS.some(image => image.id === stored.selectedId) || images.some(image => image.id === stored.selectedId)), 'BACKGROUND_CORRUPT', '背景设置已损坏，请从备份恢复。', 500)
      return { revision: Number(stored.revision), selectedId: stored.selectedId as string | null, intensity: Number(stored.intensity), images }
    })
  }

  async upload(expectedRevision: number, bytes: Buffer, filename: string) {
    this.assertRevision(expectedRevision)
    requireValue(bytes.length > 0 && bytes.length <= MAX_BACKGROUND_UPLOAD_BYTES, 'BACKGROUND_TOO_LARGE', '背景图片不能为空，且不能超过 10 MB。')
    requireValue(['image/png', 'image/jpeg', 'image/webp'].includes(imageMime(bytes) ?? ''), 'BACKGROUND_FORMAT_INVALID', '背景图片支持 JPG、PNG 和 WebP。')
    const name = imageName(filename)
    let content: Buffer, thumbnail: Buffer, width: number, height: number
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error', animated: false })
      const source = await image.metadata()
      requireValue(!source.pages || source.pages === 1, 'BACKGROUND_FORMAT_INVALID', '请选择静态背景图片。')
      const result = await image.rotate().resize({ width: 3840, height: 3840, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer({ resolveWithObject: true })
      content = result.data; width = result.info.width; height = result.info.height
      thumbnail = await sharp(content).resize(360, 225, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer()
    } catch (error) { throw error instanceof RpError ? error : new RpError('BACKGROUND_INVALID_IMAGE', '背景图片无法读取或尺寸过大，请选择另一张图片。') }
    requireValue(content.length <= MAX_BACKGROUND_UPLOAD_BYTES, 'BACKGROUND_TOO_LARGE', '背景图片不能为空，且不能超过 10 MB。')
    return this.assets.database.transaction(() => {
      const current = this.assertRevision(expectedRevision)
      requireValue(current.images.length < MAX_BACKGROUNDS, 'BACKGROUND_LIBRARY_FULL', '最多保存 24 张背景图片，请先删除不需要的图片。')
      const uploadedId = randomUUID()
      this.assets.database.orm.insert(backgroundImages).values({ id: uploadedId, name, width, height, size: content.length, content, thumbnail, createdAt: new Date().toISOString() }).run()
      this.save(current)
      return { ...this.snapshot(), uploadedId }
    })
  }

  update(expectedRevision: number, choice: BackgroundChoice) {
    return this.assets.database.transaction(() => {
      const current = this.assertRevision(expectedRevision)
      requireValue(choice.selectedId === null || BACKGROUND_PRESETS.some(image => image.id === choice.selectedId) || current.images.some(image => image.id === choice.selectedId), 'BACKGROUND_NOT_FOUND', '这张背景图片已不存在，请重新选择。', 404)
      requireValue(Number.isInteger(choice.intensity) && choice.intensity >= BACKGROUND_INTENSITY.min && choice.intensity <= BACKGROUND_INTENSITY.max, 'BACKGROUND_INTENSITY_INVALID', '背景强度需要在 5% 到 40% 之间。')
      this.save({ ...current, ...choice }); return this.snapshot()
    })
  }

  rename(expectedRevision: number, imageId: string, name: string) {
    return this.assets.database.transaction(() => {
      const current = this.assertRevision(expectedRevision)
      requireValue(!BACKGROUND_PRESETS.some(image => image.id === imageId), 'BACKGROUND_READ_ONLY', '推荐背景不能重命名或删除。')
      requireValue(current.images.some(image => image.id === imageId), 'BACKGROUND_NOT_FOUND', '这张背景图片已不存在，请重新选择。', 404)
      this.assets.database.orm.update(backgroundImages).set({ name: imageName(name) }).where(eq(backgroundImages.id, imageId)).run()
      this.save(current); return this.snapshot()
    })
  }

  remove(expectedRevision: number, imageId: string) {
    return this.assets.database.transaction(() => {
      const current = this.assertRevision(expectedRevision)
      requireValue(!BACKGROUND_PRESETS.some(image => image.id === imageId), 'BACKGROUND_READ_ONLY', '推荐背景不能重命名或删除。')
      requireValue(current.images.some(image => image.id === imageId), 'BACKGROUND_NOT_FOUND', '这张背景图片已不存在，请重新选择。', 404)
      this.assets.database.orm.delete(backgroundImages).where(eq(backgroundImages.id, imageId)).run()
      this.save({ ...current, selectedId: current.selectedId === imageId ? null : current.selectedId })
      return this.snapshot()
    })
  }

  content(imageId: string, thumbnail = false) {
    const builtin = builtinBackgroundContent(imageId, thumbnail)
    if (builtin) return builtin
    const record = this.assets.database.orm.select({ bytes: thumbnail ? backgroundImages.thumbnail : backgroundImages.content }).from(backgroundImages).where(eq(backgroundImages.id, imageId)).get()
    requireValue(record, 'BACKGROUND_NOT_FOUND', '这张背景图片已不存在，请重新选择。', 404)
    return record.bytes
  }

  private assertRevision(expected: number) {
    const current = this.snapshot()
    requireValue(current.revision === expected, 'REVISION_CONFLICT', '背景图库已更新，请刷新后重试。', 409)
    return current
  }
  private save(value: BackgroundChoice & { revision: number }) {
    const stored: StoredBackground = { version: 1, revision: value.revision + 1, selectedId: value.selectedId, intensity: value.intensity }
    this.assets.setSetting(key, { ...stored })
  }
}

function imageName(value: string) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= 200 && !/[\x00-\x1f\x7f/\\]/u.test(value), 'BACKGROUND_NAME_INVALID', '图片名称需要为 1 到 200 字，且不能包含路径或控制字符。')
  return value.trim()
}
