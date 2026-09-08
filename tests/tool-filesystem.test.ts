import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolFilesystem } from '../apps/tools/src/filesystem.ts'

describe('tool filesystem', () => {
  let directory: string, filesystem: ToolFilesystem, storyId: string, workspace: string
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'rp-tools-files-')))
    for (const name of ['workspaces', 'inputs', 'skills']) await mkdir(join(directory, name))
    filesystem = new ToolFilesystem({ workspaces: join(directory, 'workspaces'), inputs: join(directory, 'inputs'), skills: join(directory, 'skills') })
    storyId = randomUUID(); workspace = await filesystem.workspace(storyId)
  })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('creates, precisely replaces, inserts, reads ranges and undoes edits', async () => {
    await filesystem.execute(storyId, { kind: 'edit', command: 'create', path: 'story.txt', fileText: '甲\n乙\n丙' })
    await filesystem.execute(storyId, { kind: 'edit', command: 'str_replace', path: '/workspace/story.txt', oldText: '乙', newText: '替换' })
    await filesystem.execute(storyId, { kind: 'edit', command: 'insert', path: 'story.txt', insertLine: 1, newText: '插入' })
    expect(await filesystem.execute(storyId, { kind: 'read', path: 'story.txt', offset: 2, limit: 2 })).toMatchObject({ text: '插入\n替换', startLine: 2, truncated: true })
    await filesystem.execute(storyId, { kind: 'edit', command: 'undo_edit', path: 'story.txt' })
    await filesystem.execute(storyId, { kind: 'edit', command: 'undo_edit', path: 'story.txt' })
    expect(await readFile(join(workspace, 'story.txt'), 'utf8')).toBe('甲\n乙\n丙')
    await filesystem.execute(storyId, { kind: 'edit', command: 'undo_edit', path: 'story.txt' })
    await expect(readFile(join(workspace, 'story.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses ambiguous replacements and undo after an outside edit', async () => {
    await filesystem.execute(storyId, { kind: 'edit', command: 'create', path: 'x', fileText: '甲甲' })
    await expect(filesystem.execute(storyId, { kind: 'edit', command: 'str_replace', path: 'x', oldText: '甲', newText: '乙' })).rejects.toMatchObject({ code: 'EDIT_MATCH_CONFLICT' })
    expect(await readFile(join(workspace, 'x'), 'utf8')).toBe('甲甲')
    await writeFile(join(workspace, 'x'), '外部改动')
    await expect(filesystem.execute(storyId, { kind: 'edit', command: 'undo_edit', path: 'x' })).rejects.toMatchObject({ code: 'UNDO_CONFLICT' })
    expect(await readFile(join(workspace, 'x'), 'utf8')).toBe('外部改动')
  })

  it('allows attachment and skill reads, denies mutations and traversal through symlinks', async () => {
    await writeFile(join(directory, 'inputs', 'input.txt'), '附件')
    await writeFile(join(directory, 'skills', 'guide.md'), '技能')
    expect(await filesystem.execute(storyId, { kind: 'read', path: '/inputs/input.txt' })).toMatchObject({ text: '附件' })
    expect(await filesystem.execute(storyId, { kind: 'read', path: '/skills/guide.md' })).toMatchObject({ text: '技能' })
    await expect(filesystem.execute(storyId, { kind: 'edit', command: 'create', path: '/inputs/new', fileText: 'x' })).rejects.toMatchObject({ code: 'READ_ONLY_PATH' })
    await expect(filesystem.execute(storyId, { kind: 'read', path: '../../inputs/input.txt' })).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    await symlink(join(directory, 'inputs'), join(workspace, 'escape'))
    await expect(filesystem.execute(storyId, { kind: 'read', path: 'escape/input.txt' })).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    const otherStory = randomUUID()
    await symlink(join(directory, 'inputs'), join(directory, 'workspaces', otherStory))
    await expect(filesystem.workspace(otherStory)).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
  })

  it('lists directories and downloads byte-identical binary files', async () => {
    await mkdir(join(workspace, 'nested'))
    const bytes = Buffer.from([0, 255, 7, 8, 9])
    await writeFile(join(workspace, 'data.bin'), bytes)
    expect(await filesystem.execute(storyId, { kind: 'read', path: '.' })).toMatchObject({ entries: [{ name: 'nested', kind: 'directory' }, { name: 'data.bin', kind: 'file' }] })
    expect(await filesystem.execute(storyId, { kind: 'download', path: 'data.bin' })).toEqual({ name: 'data.bin', base64: bytes.toString('base64'), size: bytes.length })
    await expect(filesystem.execute(storyId, { kind: 'read', path: 'data.bin' })).rejects.toMatchObject({ code: 'FILE_NOT_TEXT' })
  })

  it('clips large UTF-8 files without replacement characters or claiming complete output', async () => {
    await writeFile(join(workspace, 'large.txt'), '汉'.repeat(800_000))
    const result = await filesystem.execute(storyId, { kind: 'read', path: 'large.txt' })
    expect(result.truncated).toBe(true)
    expect(String(result.text)).toMatch(/^汉+$/)
    expect(Buffer.byteLength(String(result.text))).toBeLessThanOrEqual(65536)
    await expect(filesystem.execute(storyId, { kind: 'edit', command: 'create', path: 'too-big', fileText: '字'.repeat(400_000) })).rejects.toMatchObject({ code: 'FILE_SIZE_LIMIT' })
    await expect(filesystem.execute(storyId, { kind: 'read', path: 'large.txt', offset: 0 })).rejects.toMatchObject({ code: 'INVALID_RANGE' })
  })
})
