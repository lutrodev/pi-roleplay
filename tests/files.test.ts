import { readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileRepository } from '../apps/server/src/storage/file-repository.ts'
import { fixture } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(item => item.close()))
function setup() { const x = fixture(); fixtures.push(x); return { ...x, files: new FileRepository(x.database, join(x.directory, 'inputs')) } }

describe('immutable uploaded files', () => {
  it('stores the original bytes and preserves user-visible names separately from storage paths', () => {
    const x = setup()
    const bytes = Buffer.from('地图\n海岸与灯塔')
    const file = x.files.save(bytes, '故事地图.txt', 'text/plain')
    expect(file.name).toBe('故事地图.txt')
    expect(file.storageKey).toMatch(/^[0-9a-f-]{36}\.txt$/)
    expect(x.files.read(file.id).bytes).toEqual(bytes)
    expect(file.size).toBe(bytes.length)
  })
  it('rolls back a new file and its index if a dependent asset transaction fails', () => {
    const x = setup()
    expect(() => x.files.withFile(Buffer.from('avatar'), 'avatar.bin', 'application/octet-stream', () => { throw new Error('asset failed') })).toThrow('asset failed')
    expect(readdirSync(x.files.directory)).toEqual([])
    expect(x.database.sqlite.prepare('SELECT COUNT(*) AS count FROM files').get()).toEqual({ count: 0 })
  })
  it('rejects path traversal, MIME impersonation, altered content and symlink substitution', () => {
    const x = setup()
    expect(() => x.files.save(Buffer.from('x'), '../private.txt')).toThrow('名称')
    expect(() => x.files.save(Buffer.from('<script>'), 'avatar.png', 'image/png')).toThrow('不一致')
    const file = x.files.save(Buffer.from('original'), 'notes.txt', 'text/plain')
    const path = join(x.files.directory, file.storageKey)
    writeFileSync(path, 'modified')
    expect(() => x.files.read(file.id)).toThrow('校验')
    const other = join(x.directory, 'outside.txt'); writeFileSync(other, 'outside')
    rmSync(path); symlinkSync(other, path)
    expect(() => x.files.read(file.id)).toThrow('无法读取')
    expect(() => x.files.read('../outside.txt')).toThrow('标识')
  })
})
