import Fastify, { type InjectOptions } from 'fastify'
import multipart from '@fastify/multipart'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { registerAuthentication } from '../apps/server/src/http/auth.ts'
import { registerErrors } from '../apps/server/src/http/errors.ts'
import { registerAssetRoutes } from '../apps/server/src/http/assets.ts'
import { registerFileRoutes } from '../apps/server/src/http/files.ts'
import { AuthService } from '../apps/server/src/services/auth-service.ts'
import { FileService } from '../apps/server/src/services/file-service.ts'
import { ToolClient } from '../apps/server/src/runtime/tool-client.ts'
import { parseCharacterCardFile } from '../packages/rp-core/src/character/character-card.js'
import { fixture } from './helpers.ts'

const close: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of close.splice(0)) await cleanup() })
const origin = 'http://rp.test', boundary = 'rp-upload-test-boundary'
function upload(parts: { name: string; type: string; bytes: Buffer }[]): Pick<InjectOptions, 'headers' | 'payload'> {
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([
    ...parts.flatMap(part => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${part.name}"\r\nContent-Type: ${part.type}\r\n\r\n`), part.bytes, Buffer.from('\r\n')]),
    Buffer.from(`--${boundary}--\r\n`),
  ]) }
}
async function setup() {
  const x = fixture(), app = Fastify({ bodyLimit: 12 * 1024 * 1024, ajv: { customOptions: { removeAdditional: false } } }), auth = new AuthService(x.assets)
  await registerAuthentication(app, auth, { publicOrigin: origin, sessionKey: randomBytes(32) })
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 0, parts: 1 } })
  registerErrors(app)
  const failures: { name: string; code?: string; message: string }[] = []
  app.addHook('onError', async (_request, _reply, error) => { failures.push({ name: error.name, code: error.code, message: error.message }) })
  const files = new FileService(x.files, x.assets, x.stories)
  registerAssetRoutes(app, x.assets, files); registerFileRoutes(app, files, new ToolClient('http://unused.test', 'x'.repeat(40)))
  close.push(async () => { await app.close(); x.close() })
  await auth.setPassword('http-assets-test-password')
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password: 'http-assets-test-password' } })
  const cookie = String(login.headers['set-cookie']).split(';')[0]!
  const call = (options: InjectOptions) => app.inject({ ...options, headers: { origin, cookie, ...options.headers } })
  return { ...x, app, call, failures }
}

describe('asset and file HTTP boundaries', () => {
  it('imports a card with an associated book, requires an explicit prompt trust choice, and exports its current state', async () => {
    const x = await setup()
    const bytes = Buffer.from(JSON.stringify({ spec: 'chara_card_v3', data: { name: '守灯人', description: '守在海岸', first_mes: '天亮了。', system_prompt: '社区作者的系统提示', character_book: { entries: [{ id: 'coast', keys: ['海岸'], content: '潮汐每天起落。', enabled: true }] } } }))
    const imported = await x.call({ method: 'POST', url: '/api/assets/import/character', ...upload([{ name: 'card.json', type: 'application/json', bytes }]) })
    expect(imported.statusCode).toBe(201)
    const { card, lorebook } = imported.json()
    expect(card.data.acceptedPromptPaths).toEqual([]); expect(card.data.quarantinedPrompts).toHaveLength(1)
    expect(lorebook.sourceCharacterId).toBe(card.id)
    expect((await x.call({ method: 'POST', url: '/api/assets/import/character', ...upload([{ name: 'card.json', type: 'application/json', bytes }]) })).json().error.code).toBe('DUPLICATE_ASSET')
    const path = card.data.quarantinedPrompts[0].path
    const accepted = await x.call({ method: 'PUT', url: `/api/assets/${card.id}`, payload: { expectedRevision: card.revision, data: { name: '新版守灯人', description: '仍守在海岸', acceptedPromptPaths: [path] } } })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().asset.data.quarantinedPrompts[0]).toMatchObject({ path, value: '社区作者的系统提示' })
    expect(accepted.json().asset.data.acceptedPromptPaths).toEqual([path])
    expect((await x.call({ method: 'PUT', url: `/api/assets/${card.id}`, payload: { expectedRevision: card.revision, data: { name: '过期修改' } } })).statusCode).toBe(409)
    const exported = await x.call({ url: `/api/assets/${card.id}/export?format=png` })
    expect(exported.statusCode).toBe(200); expect(exported.headers['content-type']).toBe('image/png')
    const decoded = parseCharacterCardFile(exported.rawPayload, 'export.png', { maxTextCharacters: 2_000_000 })
    expect(decoded.character.name).toBe('新版守灯人')
    const detail = (await x.call({ url: `/api/assets/${card.id}` })).json()
    expect(detail.associatedLorebooks[0].id).toBe(lorebook.id)
    expect((await x.call({ method: 'DELETE', url: `/api/assets/${card.id}`, payload: { expectedRevision: accepted.json().asset.revision } })).json().associatedFailures).toEqual([])
    expect((await x.call({ url: `/api/assets/${lorebook.id}` })).statusCode).toBe(404)
  })

  it('validates native lore edits strictly and returns bounded catalog metadata without full prompts', async () => {
    const x = await setup(), entry = { id: 'sea', name: '海', content: '蓝色的海。', level: 'worldDescription', constant: true, enabled: true }
    const created = await x.call({ method: 'POST', url: '/api/assets', payload: { kind: 'lorebook', data: { name: '海岸世界', entries: [entry], scanDepth: 5, recursiveScanning: false } } })
    expect(created.statusCode).toBe(201)
    const asset = created.json().asset
    const invalid = await x.call({ method: 'PUT', url: `/api/assets/${asset.id}`, payload: { expectedRevision: asset.revision, data: { name: '修改', entries: [{ ...entry, enabled: 'false' }] } } })
    expect(invalid.statusCode).toBe(400)
    expect(x.assets.get(asset.id).revision).toBe(1)
    x.assets.create('lorebook', { name: '海岸补充', entries: [] })
    const page = (await x.call({ url: '/api/assets?kind=lorebook&q=海岸&limit=1' })).json()
    expect(page).toMatchObject({ total: 2, nextOffset: 1 }); expect(page.assets).toHaveLength(1)
    expect(page.assets[0]).not.toHaveProperty('data')
    expect((await x.call({ url: '/api/assets?kind=lorebook&q=海岸&limit=1&offset=1' })).json().nextOffset).toBe(null)
    expect((await x.call({ url: '/api/assets?kind=secret' })).statusCode).toBe(400)
    const defaults = (await x.call({ url: '/api/assets/defaults' })).json().defaults
    expect(defaults.preset).toBeTypeOf('string')
    expect((await x.call({ method: 'PUT', url: '/api/assets/defaults', payload: { kind: 'preset', assetId: asset.id } })).statusCode).toBe(404)
  })

  it('authenticates file reads, forces active content to download, validates multipart atomicity and saves clean avatars with CAS', async () => {
    const x = await setup(), html = Buffer.from('<script>document.cookie</script>')
    const created = await x.call({ method: 'POST', url: '/api/files', ...upload([{ name: 'report.html', type: 'text/html', bytes: html }]) })
    expect(created.statusCode).toBe(201)
    const file = created.json().file, url = `/api/files/${file.id}/content`
    expect((await x.app.inject({ url })).statusCode).toBe(401)
    const download = await x.call({ url })
    expect(download.rawPayload).toEqual(html)
    expect(download.headers['content-disposition']).toContain('attachment;')
    expect(download.headers['content-security-policy']).toContain('sandbox')
    expect(download.headers['x-content-type-options']).toBe('nosniff')
    const count = x.database.sqlite.prepare('SELECT count(*) AS n FROM files').get() as { n: number }
    const extra = await x.call({ method: 'POST', url: '/api/files', ...upload([{ name: 'one.txt', type: 'text/plain', bytes: html }, { name: 'two.txt', type: 'text/plain', bytes: html }]) })
    expect(extra.statusCode, JSON.stringify(x.failures)).toBe(400)
    expect(x.database.sqlite.prepare('SELECT count(*) AS n FROM files').get()).toEqual(count)
    expect((await x.call({ method: 'POST', url: '/api/files', ...upload([{ name: 'bad.png', type: 'image/png', bytes: html }]) })).statusCode).toBe(400)
    const persona = x.assets.create('persona', { name: '旅人' }), png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#386f74' } }).png().toBuffer()
    const avatar = await x.call({ method: 'PUT', url: `/api/assets/${persona.id}/avatar?expectedRevision=1`, ...upload([{ name: '头像.png', type: 'image/png', bytes: png }]) })
    expect(avatar.statusCode).toBe(200)
    const asset = avatar.json().asset
    const image = await x.call({ url: `/api/files/${asset.avatarFileId}/content` })
    expect(image.headers['content-disposition']).toContain('inline;')
    expect((await x.call({ method: 'PUT', url: `/api/assets/${persona.id}/avatar?expectedRevision=1`, ...upload([{ name: '头像.png', type: 'image/png', bytes: png }]) })).statusCode).toBe(409)
    expect((await x.call({ method: 'DELETE', url: `/api/assets/${persona.id}/avatar`, payload: { expectedRevision: asset.revision } })).json().asset.avatarFileId).toBe(null)
  })
})
