import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { FileRecord } from '../../../../packages/rp-core/src/types.ts'
import type { AppDatabase } from './database.ts'
import { files } from './schema.ts'

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Immutable attachment bytes, indexed by SQLite. Tools mount only this directory, read-only. */
export class FileRepository {
  readonly directory: string
  constructor(readonly database: AppDatabase, directory: string) {
    this.directory = resolve(directory)
    mkdirSync(this.directory, { recursive: true, mode: 0o750 })
  }

  get(id: string): FileRecord {
    requireValue(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 'FILE_NOT_FOUND', '附件标识不正确。', 404)
    const file = this.database.orm.select().from(files).where(eq(files.id, id)).get()
    requireValue(file, 'FILE_NOT_FOUND', '这个附件已不存在。', 404)
    return file
  }

  save(bytes: Buffer, name: string, mimeType = 'application/octet-stream'): FileRecord {
    return this.withFile(bytes, name, mimeType, file => file)
  }

  findImage(sha256: string, mimeType: string) {
    return this.database.orm.select().from(files).where(and(eq(files.sha256, sha256), eq(files.mimeType, mimeType))).get()
  }

  /** The callback commits the dependent asset in the same DB transaction; failure removes the new bytes. */
  withFile<T>(bytes: Buffer, name: string, mimeType: string, operation: (file: FileRecord) => T): T {
    requireValue(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_UPLOAD_BYTES, 'UPLOAD_TOO_LARGE', '附件不能为空，且每个附件不能超过 25 MB。')
    requireValue(typeof name === 'string' && name.trim().length > 0 && [...name].length <= 200 && !/[\x00-\x1f\x7f/\\]/u.test(name) && name !== '.' && name !== '..',
      'INVALID_FILENAME', '附件名称不正确。')
    requireValue(typeof mimeType === 'string' && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeType) && mimeType.length <= 128,
      'INVALID_FILE_TYPE', '附件类型不正确。')
    const detected = imageMime(bytes)
    if (IMAGE_MIMES.has(mimeType)) requireValue(detected === mimeType, 'INVALID_IMAGE', '图片内容与声明格式不一致。')
    const id = randomUUID()
    const extension = extname(name).toLowerCase()
    const storageKey = id + (/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '')
    const file: FileRecord = { id, name: name.trim(), mimeType: detected ?? mimeType.toLowerCase(), storageKey,
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() }
    const path = join(this.directory, storageKey)
    let created = false
    try {
      const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o640)
      created = true
      try { writeFileSync(descriptor, bytes); fsyncSync(descriptor) } finally { closeSync(descriptor) }
      const directoryDescriptor = openSync(this.directory, constants.O_RDONLY)
      try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
      return this.database.transaction(() => {
        this.database.orm.insert(files).values(file).run()
        return operation(file)
      })
    } catch (error) {
      if (created) rmSync(path, { force: true })
      throw error
    }
  }

  read(id: string) {
    const file = this.get(id)
    requireValue(/^[0-9a-f-]{36}(\.[a-z0-9]{1,12})?$/.test(file.storageKey), 'FILE_CORRUPT', '附件存储标识损坏。', 500)
    let descriptor: number | undefined
    try {
      descriptor = openSync(join(this.directory, file.storageKey), constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = fstatSync(descriptor)
      requireValue(info.isFile() && info.size === file.size && info.size <= MAX_UPLOAD_BYTES, 'FILE_CORRUPT', '附件文件缺失或内容损坏。', 500)
      const bytes = readFileSync(descriptor)
      requireValue(createHash('sha256').update(bytes).digest('hex') === file.sha256, 'FILE_CORRUPT', '附件内容校验失败。', 500)
      return { file, bytes }
    } catch (error) {
      if (error instanceof RpError) throw error
      throw new RpError('FILE_UNAVAILABLE', '附件文件无法读取，请检查数据目录。', 500)
    } finally { if (descriptor !== undefined) closeSync(descriptor) }
  }
}

export function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif'
  return undefined
}
