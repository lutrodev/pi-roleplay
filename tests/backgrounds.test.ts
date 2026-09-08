import Fastify, { type InjectOptions } from 'fastify'
import multipart from '@fastify/multipart'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { BackgroundService } from '../apps/server/src/services/background-service.ts'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { AssetRepository } from '../apps/server/src/storage/asset-repository.ts'
import { AuthService } from '../apps/server/src/services/auth-service.ts'
import { registerAuthentication } from '../apps/server/src/http/auth.ts'
import { registerErrors } from '../apps/server/src/http/errors.ts'
import { registerBackgrounds } from '../apps/server/src/http/backgrounds.ts'
import { BACKGROUND_PRESETS, MAX_BACKGROUNDS, MAX_BACKGROUND_UPLOAD_BYTES, findBackground } from '../packages/protocol/src/backgrounds.ts'
import { fixture } from './helpers.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
function setup() { const x = fixture(); cleanups.push(() => x.close()); return { ...x, backgrounds: new BackgroundService(x.assets) } }
const photo = () => sharp({ create: { width: 800, height: 400, channels: 3, background: '#417784' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer()

describe('private background library', () => {
  it('offers shipped presets without consuming upload slots and restores a saved preset selection', async () => {
    const x = setup()
    expect(x.backgrounds.snapshot()).toMatchObject({ selectedId: null, images: [] })
    for (const image of BACKGROUND_PRESETS) {
      const full = await sharp(x.backgrounds.content(image.id)).metadata(), thumbnail = await sharp(x.backgrounds.content(image.id, true)).metadata()
      expect(full).toMatchObject({ format: 'webp', width: image.width, height: image.height })
      expect(thumbnail).toMatchObject({ format: 'webp', width: 360, height: 225 })
      expect(full.exif).toBeUndefined()
      const saved = x.backgrounds.update(x.backgrounds.snapshot().revision, { selectedId: image.id, intensity: 24 })
      expect(findBackground(saved, saved.selectedId)).toEqual(image)
      expect(() => x.backgrounds.rename(saved.revision, image.id, 'new name')).toThrow('推荐背景不能')
      expect(() => x.backgrounds.remove(saved.revision, image.id)).toThrow('推荐背景不能')
      expect(x.backgrounds.snapshot()).toEqual(saved)
    }
    const selectedId = BACKGROUND_PRESETS[2]!.id
    const uploaded = await x.backgrounds.upload(x.backgrounds.snapshot().revision, await photo(), '自选图片.jpg')
    expect(uploaded).toMatchObject({ selectedId, images: [expect.objectContaining({ name: '自选图片.jpg' })] })
    const saved = x.backgrounds.remove(uploaded.revision, uploaded.uploadedId)
    expect(saved).toMatchObject({ selectedId, images: [] })
    const backup = join(x.directory, 'preset-restore.sqlite')
    await x.database.sqlite.backup(backup)
    const restoredDb = new AppDatabase(backup)
    try {
      const restored = new BackgroundService(new AssetRepository(restoredDb))
      expect(restored.snapshot()).toEqual(saved)
      expect(restored.content(selectedId)).toEqual(x.backgrounds.content(selectedId))
      expect(restoredDb.sqlite.prepare('SELECT count(*) AS n FROM background_images').get()).toEqual({ n: 0 })
    } finally { restoredDb.close() }
    expect(readdirSync(x.files.directory)).toEqual([])
    expect(x.database.sqlite.prepare('SELECT count(*) AS n FROM assets').get()).toEqual({ n: 0 })
  })

  it('cleans image metadata, rotates pixels, stores bounded previews, and isolates images from attachments and RP assets', async () => {
    const x = setup(), before = x.backgrounds.snapshot()
    expect(before).toEqual({ revision: 1, selectedId: null, intensity: 18, images: [] })
    const uploaded = await x.backgrounds.upload(before.revision, await photo(), '海岸.jpg')
    expect(uploaded).toMatchObject({ revision: 2, selectedId: null, intensity: 18, images: [{ name: '海岸.jpg', width: 400, height: 800 }] })
    expect(uploaded.images[0]).not.toHaveProperty('content')
    const image = await sharp(x.backgrounds.content(uploaded.uploadedId)).metadata()
    expect(image).toMatchObject({ format: 'webp', width: 400, height: 800 })
    expect(image.exif).toBeUndefined(); expect(image.icc).toBeUndefined()
    const thumb = await sharp(x.backgrounds.content(uploaded.uploadedId, true)).metadata()
    expect(thumb.width).toBeLessThanOrEqual(360); expect(thumb.height).toBeLessThanOrEqual(225)
    expect(() => x.files.get(uploaded.uploadedId)).toThrow('已不存在')
    expect(readdirSync(x.files.directory)).toEqual([])
    expect(x.database.sqlite.prepare('SELECT count(*) AS n FROM assets').get()).toEqual({ n: 0 })
    expect(x.database.sqlite.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 0 })
  })

  it('switches, renames, disables and deletes atomically without changing unrelated settings', async () => {
    const x = setup(), bytes = await photo()
    x.assets.setSetting('app.preferences', { sentinel: 'other settings' })
    const a = await x.backgrounds.upload(1, bytes, '海岸.jpg'), b = await x.backgrounds.upload(a.revision, bytes, '山林.jpg')
    const active = x.backgrounds.update(b.revision, { selectedId: a.uploadedId, intensity: 27 })
    const content = x.backgrounds.content(a.uploadedId)
    const renamed = x.backgrounds.rename(active.revision, a.uploadedId, '  晨间海岸  ')
    expect(renamed.images.find(image => image.id === a.uploadedId)?.name).toBe('晨间海岸')
    expect(x.backgrounds.content(a.uploadedId)).toEqual(content)
    expect(() => x.backgrounds.remove(active.revision, a.uploadedId)).toThrow('图库已更新')
    const removedOther = x.backgrounds.remove(renamed.revision, b.uploadedId)
    expect(removedOther.selectedId).toBe(a.uploadedId)
    const disabled = x.backgrounds.update(removedOther.revision, { selectedId: null, intensity: 27 })
    expect(disabled.images).toHaveLength(1)
    const selected = x.backgrounds.update(disabled.revision, { selectedId: a.uploadedId, intensity: 27 })
    const deleted = x.backgrounds.remove(selected.revision, a.uploadedId)
    expect(deleted).toMatchObject({ selectedId: null, intensity: 27, images: [] })
    expect(() => x.backgrounds.content(a.uploadedId)).toThrow('已不存在')
    expect(x.assets.getSetting('app.preferences')).toEqual({ sentinel: 'other settings' })
  })

  it('rejects invalid images, limits, missing selections and stale concurrent uploads without partial writes', async () => {
    const x = setup(), before = x.backgrounds.snapshot(), bytes = await photo()
    for (const input of [Buffer.from('<svg></svg>'), Buffer.from('GIF89a'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]) {
      await expect(x.backgrounds.upload(1, input, 'invalid.png')).rejects.toThrow()
    }
    await expect(x.backgrounds.upload(1, Buffer.alloc(MAX_BACKGROUND_UPLOAD_BYTES + 1), 'large.png')).rejects.toThrow('10 MB')
    await expect(x.backgrounds.upload(1, bytes, '../private.png')).rejects.toThrow('图片名称')
    expect(() => x.backgrounds.update(1, { selectedId: randomUUID(), intensity: 18 })).toThrow('已不存在')
    for (const intensity of [0, 41, 15.5, NaN]) expect(() => x.backgrounds.update(1, { selectedId: null, intensity })).toThrow('背景强度')
    expect(x.backgrounds.snapshot()).toEqual(before)
    const concurrent = await Promise.allSettled([x.backgrounds.upload(1, bytes, 'one.jpg'), x.backgrounds.upload(1, bytes, 'two.jpg')])
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(x.backgrounds.snapshot().images).toHaveLength(1)
    const original = x.database.sqlite.prepare('SELECT * FROM background_images').get() as Record<string, unknown>
    const insert = x.database.sqlite.prepare('INSERT INTO background_images (id, name, width, height, size, content, thumbnail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (let i = 1; i < MAX_BACKGROUNDS; i++) insert.run(randomUUID(), `fixture ${i}`, original.width, original.height, original.size, original.content, original.thumbnail, original.created_at)
    const full = x.backgrounds.snapshot()
    await expect(x.backgrounds.upload(full.revision, bytes, 'overflow.jpg')).rejects.toThrow('24 张')
    expect(x.backgrounds.snapshot()).toEqual(full)
  })

  it('restores the library, current selection, strength and exact image bytes from a standalone SQLite backup', async () => {
    const x = setup(), uploaded = await x.backgrounds.upload(1, await photo(), '备份图片.jpg')
    const saved = x.backgrounds.update(uploaded.revision, { selectedId: uploaded.uploadedId, intensity: 32 })
    const content = x.backgrounds.content(uploaded.uploadedId), thumbnail = x.backgrounds.content(uploaded.uploadedId, true)
    const backup = join(x.directory, 'restored.sqlite')
    await x.database.sqlite.backup(backup)
    const restoredDb = new AppDatabase(backup)
    try {
      const restored = new BackgroundService(new AssetRepository(restoredDb))
      expect(restored.snapshot()).toEqual(saved)
      expect(restored.content(uploaded.uploadedId)).toEqual(content)
      expect(restored.content(uploaded.uploadedId, true)).toEqual(thumbnail)
      expect(restoredDb.sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally { restoredDb.close() }
  })
})

const origin = 'http://background.test', boundary = 'background-test-upload'
function upload(parts: { name: string; type: string; bytes: Buffer }[]): Pick<InjectOptions, 'headers' | 'payload'> {
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([
    ...parts.flatMap(part => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${part.name}"\r\nContent-Type: ${part.type}\r\n\r\n`), part.bytes, Buffer.from('\r\n')]), Buffer.from(`--${boundary}--\r\n`),
  ]) }
}
async function httpSetup() {
  const x = setup(), app = Fastify({ ajv: { customOptions: { removeAdditional: false } } }), auth = new AuthService(x.assets)
  registerErrors(app)
  await registerAuthentication(app, auth, { publicOrigin: origin, sessionKey: randomBytes(32) })
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 0, parts: 1 } })
  registerBackgrounds(app, x.backgrounds)
  cleanups.push(() => app.close())
  await auth.setPassword('background-synthetic-password')
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password: 'background-synthetic-password' } })
  const cookie = String(login.headers['set-cookie']).split(';')[0]!
  const call = (options: InjectOptions) => app.inject({ ...options, headers: { origin, cookie, ...options.headers } })
  return { ...x, app, call }
}

describe('background HTTP boundaries', () => {
  it('serves presets through the authenticated image route and keeps presets read-only', async () => {
    const x = await httpSetup(), path = '/api/settings/backgrounds', image = BACKGROUND_PRESETS[0]!
    for (const suffix of ['', '?thumbnail=true']) {
      expect((await x.app.inject({ url: `${path}/${image.id}/content${suffix}` })).statusCode).toBe(401)
      const content = await x.call({ url: `${path}/${image.id}/content${suffix}` })
      expect(content.statusCode).toBe(200)
      expect(content.headers['content-type']).toBe('image/webp')
    }
    const selected = await x.call({ method: 'PUT', url: path, payload: { expectedRevision: 1, selectedId: image.id, intensity: 18 } })
    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toMatchObject({ revision: 2, selectedId: image.id, images: [] })
    expect((await x.call({ method: 'PATCH', url: `${path}/${image.id}`, payload: { expectedRevision: 2, name: 'rename' } })).statusCode).toBe(400)
    expect((await x.call({ method: 'DELETE', url: `${path}/${image.id}`, payload: { expectedRevision: 2 } })).statusCode).toBe(400)
    expect(x.backgrounds.snapshot().revision).toBe(2)
  })

  it('authenticates the library and images and supports the complete upload/manage/apply flow', async () => {
    const x = await httpSetup(), path = '/api/settings/backgrounds'
    expect((await x.app.inject({ url: path })).statusCode).toBe(401)
    expect((await x.call({ method: 'PUT', url: path, headers: { origin: 'http://outside.test' }, payload: { expectedRevision: 1, selectedId: null, intensity: 18 } })).statusCode).toBe(403)
    const created = await x.call({ method: 'POST', url: path + '?expectedRevision=1', ...upload([{ name: 'sea.jpg', type: 'image/jpeg', bytes: await photo() }]) })
    expect(created.statusCode).toBe(201)
    const id = created.json().uploadedId, content = `${path}/${id}/content`
    expect((await x.app.inject({ url: content })).statusCode).toBe(401)
    expect((await x.app.inject({ url: content + '?thumbnail=true' })).statusCode).toBe(401)
    for (const url of [content, content + '?thumbnail=true']) {
      const image = await x.call({ url })
      expect(image.headers['content-type']).toBe('image/webp')
      expect(image.headers['x-content-type-options']).toBe('nosniff')
      expect(image.headers['cache-control']).toBe('no-store')
      expect(await sharp(image.rawPayload).metadata()).toMatchObject({ format: 'webp' })
    }
    const chosen = await x.call({ method: 'PUT', url: path, payload: { expectedRevision: 2, selectedId: id, intensity: 25 } })
    expect(chosen.statusCode).toBe(200); expect(chosen.json().selectedId).toBe(id)
    const renamed = await x.call({ method: 'PATCH', url: `${path}/${id}`, payload: { expectedRevision: 3, name: '海岸' } })
    expect(renamed.statusCode).toBe(200); expect(renamed.json().images[0].name).toBe('海岸')
    expect((await x.call({ method: 'DELETE', url: `${path}/${id}`, payload: { expectedRevision: 3 } })).statusCode).toBe(409)
    const removed = await x.call({ method: 'DELETE', url: `${path}/${id}`, payload: { expectedRevision: 4 } })
    expect(removed.statusCode).toBe(200); expect(removed.json()).toMatchObject({ selectedId: null, images: [] })
    expect((await x.call({ url: content })).statusCode).toBe(404)
  })

  it('rejects malformed and oversized multipart requests before anything is committed', async () => {
    const x = await httpSetup(), path = '/api/settings/backgrounds', before = x.backgrounds.snapshot()
    const image = { name: 'photo.jpg', type: 'image/jpeg', bytes: await photo() }
    expect((await x.call({ method: 'POST', url: path + '?expectedRevision=1', ...upload([image, image]) })).statusCode).toBe(400)
    expect((await x.call({ method: 'POST', url: path + '?expectedRevision=1', ...upload([{ ...image, bytes: Buffer.alloc(MAX_BACKGROUND_UPLOAD_BYTES + 1) }]) })).statusCode).toBe(413)
    expect((await x.call({ method: 'PUT', url: path, payload: { expectedRevision: 1, selectedId: null, intensity: 18, extra: true } })).statusCode).toBe(400)
    expect(x.backgrounds.snapshot()).toEqual(before)
  })
})
