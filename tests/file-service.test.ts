import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { FileService } from '../apps/server/src/services/file-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { encodeCharacterCardV3Png, parseCharacterCardFile, serializeCharacterCardV3 } from '../packages/rp-core/src/character/character-card.js'
import { fixture } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(item => item.close()))
function setup() { const x = fixture(); fixtures.push(x); return { ...x,
  service: new FileService(x.files, x.assets, x.stories), storyService: new StoryService(x.stories, x.assets, x.files) } }

describe('character assets, avatars and attachments', () => {
  it('imports a real PNG card, cleans avatar metadata, exports current edits and retains MVU source fields after edits', async () => {
    const x = setup()
    const avatar = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).withMetadata().png().toBuffer()
    const payload = serializeCharacterCardV3({ name: '守塔人', description: '原描述', firstMessage: '<initvar>{"energy":10}</initvar>欢迎。' }, { characterBook: {
      name: '海岸', entries: [{ id: 'coast', keys: ['海岸'], content: '海岸有一座灯塔。', enabled: true }],
    } })
    const png = Buffer.from(encodeCharacterCardV3Png(payload, avatar))
    const imported = await x.service.importCharacter(png, 'character.png')
    expect(imported.card.avatarFileId).toBeTruthy()
    expect(imported.lorebook).not.toBeNull()
    const clean = x.files.read(imported.card.avatarFileId!).bytes
    const metadata = await sharp(clean).metadata()
    expect(metadata.exif).toBeUndefined()
    expect(metadata.icc).toBeUndefined()
    expect(clean.includes(Buffer.from('ccv3'))).toBe(false)
    const originalSource = imported.card.data.sourcePayload
    const edited = x.assets.update(imported.card.id, 1, { name: '守塔人', description: '已编辑的描述', firstMessage: '欢迎。' })
    expect(edited.data.characterBook).toEqual(imported.card.data.characterBook)
    expect(edited.data.sourcePayload).toEqual(originalSource)
    const exported = x.service.exportCharacter(edited.id, 'png')
    const reparsed = parseCharacterCardFile(exported.bytes, exported.name, { maxTextCharacters: 2_000_000 })
    expect(reparsed.character.description).toBe('已编辑的描述')
    expect(reparsed.lorebookEntries).toBe(1)
    const before = x.database.sqlite.prepare('SELECT COUNT(*) AS n FROM files').get()
    await expect(x.service.importCharacter(png, 'same.png')).rejects.toThrow('已经导入')
    expect(x.database.sqlite.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual(before)
  })

  it('atomically replaces a persona avatar, rejects stale replacement and clears its binding', async () => {
    const x = setup()
    const persona = x.assets.create('persona', { name: '旅行者' })
    const jpeg = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#eee' } }).jpeg().toBuffer()
    const updated = await x.service.updateAvatar(persona.id, 1, jpeg)
    expect(updated.revision).toBe(2)
    const dimensions = await sharp(x.files.read(updated.avatarFileId!).bytes).metadata()
    expect(dimensions).toMatchObject({ format: 'webp', width: 512, height: 256 })
    await expect(x.service.updateAvatar(persona.id, 1, jpeg)).rejects.toThrow('已经更新')
    expect((await x.service.updateAvatar(persona.id, 2, null)).avatarFileId).toBeNull()
  })

  it('validates attachment existence before accepting messages and forwards identical images to model runs', async () => {
    const x = setup()
    const story = x.storyService.create('附件测试')
    expect(() => x.storyService.send(story.id, 'missing', [{ text: '图片', attachmentIds: ['missing'] }])).toThrow('标识')
    expect(x.stories.snapshot(story.id).messages).toEqual([])
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#369' } }).png().toBuffer()
    const file = await x.service.upload(image, '附件.png', 'image/png')
    const document = await x.service.upload(Buffer.from('设定资料'), '附件.txt', 'text/plain')
    const run = x.storyService.send(story.id, 'ok', [{ text: '结合附件写作', attachmentIds: [file.id, document.id] }]).run
    const inputs = x.service.attachmentsForRun(run.id)
    expect(inputs.files.map(item => item.id)).toEqual([file.id, document.id])
    expect(inputs.images).toEqual([{ type: 'image', mimeType: 'image/png', data: image.toString('base64') }])
    await expect(x.service.upload(Buffer.from('invalid'), 'bad.png', 'image/png')).rejects.toThrow('无法解码')
  })

  it('retains the 20 MiB card, 5 MiB avatar and 16,777,216 pixel avatar boundaries without changing assets on rejection', async () => {
    const x = setup(), persona = x.assets.create('persona', { name: '边界' })
    await expect(x.service.importCharacter(Buffer.alloc(20 * 1024 * 1024 + 1), 'too-large.png')).rejects.toThrow('20 MB')
    await expect(x.service.updateAvatar(persona.id, 1, Buffer.alloc(5 * 1024 * 1024 + 1))).rejects.toThrow('5 MB')
    const pixels = await sharp({ create: { width: 4096, height: 4097, channels: 3, background: '#fff' } }).png().toBuffer()
    await expect(x.service.updateAvatar(persona.id, 1, pixels)).rejects.toThrow('尺寸超过限制')
    expect(x.assets.get(persona.id)).toMatchObject({ revision: 1, avatarFileId: null })
  })
})
