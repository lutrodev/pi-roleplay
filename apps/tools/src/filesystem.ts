import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { RpError, requireValue } from '../../../packages/rp-core/src/errors.ts'
import type { FileCommand } from '../../../packages/protocol/src/tools.ts'
import { workspaceDirectory } from '../../../packages/rp-core/src/workspace.ts'

const MAX_EDIT_BYTES = 1024 * 1024
const MAX_SCAN_BYTES = 2 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
interface Undo { before: Buffer | null; afterHash: string }

/** Explicit virtual mounts. This boundary is also used by read-only specialist tools. */
export class ToolFilesystem {
  private readonly undo = new Map<string, Undo[]>()
  constructor(readonly roots: { workspaces: string; inputs: string; skills: string }) {}

  async workspace(directory: string, createIfMissing = true) {
    workspaceDirectory(directory)
    await mkdir(this.roots.workspaces, { recursive: true, mode: 0o750 })
    const root = await realpath(this.roots.workspaces), path = resolve(root, directory)
    // Check every ancestor before creation; symlinks within the volume are not directory aliases either.
    requireValue(await realpath(dirname(path)).catch(() => '') === dirname(path), 'PATH_NOT_ALLOWED', '工作区父目录不存在或包含符号链接。', 403)
    if (createIfMissing) await mkdir(path, { recursive: true, mode: 0o750 })
    requireValue(await realpath(path).catch(() => '') === path, 'PATH_NOT_ALLOWED', '工作区不存在或包含符号链接。', 403)
    requireValue((await stat(path)).isDirectory(), 'INVALID_WORKSPACE_DIRECTORY', '工作区必须是目录。')
    return path
  }

  async prepareDirectory(directory: string) {
    workspaceDirectory(directory)
    await mkdir(this.roots.workspaces, { recursive: true, mode: 0o750 })
    const root = await realpath(this.roots.workspaces), path = resolve(root, directory)
    requireValue(await realpath(dirname(path)).catch(() => '') === dirname(path), 'PATH_NOT_ALLOWED', '工作区父目录不存在或包含符号链接。', 403)
    try { await mkdir(path, { mode: 0o750 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RpError('WORKSPACE_DIRECTORY_EXISTS', '工作区目录已经存在，请重新创建工作区。', 409); throw error }
    await this.workspace(directory, false)
    return { directory }
  }

  async execute(storyId: string, command: FileCommand, createIfMissing = true): Promise<Record<string, unknown>> {
    const writable = command.kind === 'edit'
    const path = await this.path(storyId, command.path ?? '.', writable, createIfMissing)
    if (command.kind === 'list') {
      const entries = await readdir(path, { withFileTypes: true })
      const ordered = entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      return { entries: ordered.slice(0, 500).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' })), truncated: entries.length > 500 }
    }
    if (command.kind === 'download') {
      const bytes = await this.bytes(path, MAX_DOWNLOAD_BYTES)
      return { name: basename(path), base64: bytes.toString('base64'), size: bytes.length }
    }
    if (command.kind === 'read') {
      const info = await stat(path)
      if (info.isDirectory()) return this.execute(storyId, { kind: 'list', path: command.path }, createIfMissing)
      requireValue(info.isFile(), 'FILE_NOT_REGULAR', '只允许读取普通文件。')
      const offset = command.offset ?? 1, limit = command.limit ?? 2000
      requireValue(Number.isSafeInteger(offset) && offset >= 1 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 2000, 'INVALID_RANGE', '读取范围必须从第 1 行开始，每次最多读取 2000 行。')
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let bytes: Buffer
      try { bytes = Buffer.alloc(Math.min(info.size, MAX_SCAN_BYTES)); const result = await handle.read(bytes); bytes = bytes.subarray(0, result.bytesRead) }
      finally { await handle.close() }
      const content = decode(bytes, info.size > bytes.length)
      const lines = content.split('\n')
      requireValue(offset <= lines.length || info.size <= MAX_SCAN_BYTES, 'SCAN_LIMIT', '所需行超出读取上限，请用 Bash 搜索并提取指定范围。')
      let text = lines.slice(offset - 1, offset - 1 + limit).join('\n')
      const truncated = offset - 1 + limit < lines.length || info.size > MAX_SCAN_BYTES || Buffer.byteLength(text) > 65536
      if (Buffer.byteLength(text) > 65536) text = decode(Buffer.from(text).subarray(0, 65536), true)
      return { text, startLine: offset, truncated, ...(truncated ? { note: '内容已按行数或字节上限截取，请继续读取后续范围。' } : {}) }
    }
    return this.edit(path, command)
  }

  private async path(storyId: string, supplied: string, writable: boolean, createIfMissing: boolean) {
    requireValue(typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 4096 && !supplied.includes('\0'), 'INVALID_PATH', '文件路径不正确。')
    const workspace = await this.workspace(storyId, createIfMissing)
    let root: string, suffix: string
    if (supplied === '/inputs' || supplied.startsWith('/inputs/')) { root = await realpath(this.roots.inputs); suffix = supplied.slice('/inputs'.length) }
    else if (supplied === '/skills' || supplied.startsWith('/skills/')) { root = await realpath(this.roots.skills); suffix = supplied.slice('/skills'.length) }
    else if (supplied === '/workspace' || supplied.startsWith('/workspace/')) { root = workspace; suffix = supplied.slice('/workspace'.length) }
    else if (isAbsolute(supplied)) { root = workspace; suffix = relative(workspace, supplied) }
    else { root = workspace; suffix = supplied }
    requireValue(!writable || root === workspace, 'READ_ONLY_PATH', '附件和 Skills 目录只允许读取。', 403)
    const target = resolve(root, suffix.replace(/^\/+/, ''))
    requireValue(within(root, target), 'PATH_NOT_ALLOWED', '文件路径超出了允许的目录。', 403)
    let canonical: string
    try { canonical = await realpath(target) }
    catch (error) {
      if (!writable || !isMissing(error)) throw new RpError('FILE_NOT_FOUND', '文件或目录不存在。', 404)
      try { canonical = join(await realpath(dirname(target)), basename(target)) }
      catch { throw new RpError('FILE_NOT_FOUND', '父目录不存在，请先使用 Bash 创建目录。', 404) }
    }
    requireValue(within(root, canonical), 'PATH_NOT_ALLOWED', '符号链接指向了允许目录之外。', 403)
    return canonical
  }

  private async bytes(path: string, maximum: number) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      requireValue(info.isFile() && info.size <= maximum, 'FILE_SIZE_LIMIT', `文件不是普通文件，或超过 ${Math.floor(maximum / 1024 / 1024)} MB 上限。`)
      const bytes = Buffer.alloc(Math.min(info.size, maximum) + 1)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      requireValue(offset === info.size, 'FILE_CHANGED', '文件正在被其他操作修改，请重新读取。', 409)
      return bytes.subarray(0, offset)
    } finally { await handle.close() }
  }

  private async edit(path: string, command: Extract<FileCommand, { kind: 'edit' }>) {
    let before: Buffer | null = null
    try { before = await this.bytes(path, MAX_EDIT_BYTES) } catch (error) { if (!isMissing(error)) throw error }
    if (command.command === 'undo_edit') {
      const stack = this.undo.get(path), undo = stack?.at(-1)
      requireValue(undo && before && hash(before) === undo.afterHash, 'UNDO_CONFLICT', '没有可撤销的编辑，或文件已被其他操作修改。', 409)
      if (undo.before === null) await rm(path)
      else await this.atomicWrite(path, undo.before)
      stack!.pop()
      return { path: basename(path), restored: true }
    }
    let next: string
    if (command.command === 'create' || command.command === 'write') {
      requireValue(command.command === 'write' || before === null, 'FILE_EXISTS', '文件已经存在，请使用替换或插入操作。', 409)
      requireValue(typeof command.fileText === 'string', 'INVALID_EDIT', '创建文件需要 fileText。')
      next = command.fileText
    } else {
      requireValue(before, 'FILE_NOT_FOUND', '要编辑的文件不存在。', 404)
      const current = decode(before)
      if (command.command === 'str_replace') {
        requireValue(typeof command.oldText === 'string' && command.oldText.length > 0 && typeof command.newText === 'string', 'INVALID_EDIT', '替换需要非空原文和新的文本。')
        const at = current.indexOf(command.oldText)
        requireValue(at >= 0 && (command.replaceAll === true || current.indexOf(command.oldText, at + 1) < 0), 'EDIT_MATCH_CONFLICT', '原文不存在或存在多个匹配；全部替换需明确设置 replace_all。', 409)
        next = command.replaceAll ? current.split(command.oldText).join(command.newText) : current.slice(0, at) + command.newText + current.slice(at + command.oldText.length)
      } else {
        const lines = current.split('\n')
        requireValue(Number.isSafeInteger(command.insertLine) && command.insertLine! >= 0 && command.insertLine! <= lines.length && typeof command.newText === 'string', 'INVALID_EDIT', '插入位置或文本不正确。')
        lines.splice(command.insertLine!, 0, ...command.newText.split('\n'))
        next = lines.join('\n')
      }
    }
    const bytes = Buffer.from(next)
    requireValue(bytes.length <= MAX_EDIT_BYTES, 'FILE_SIZE_LIMIT', '编辑后的文件不能超过 1 MB。')
    await this.atomicWrite(path, bytes)
    const stack = this.undo.get(path) ?? []
    stack.push({ before, afterHash: hash(bytes) })
    if (stack.length > 8) stack.shift()
    this.undo.delete(path); this.undo.set(path, stack)
    if (this.undo.size > 32) this.undo.delete(this.undo.keys().next().value!)
    return { path: basename(path), bytes: bytes.length, changed: true }
  }

  private async atomicWrite(path: string, bytes: Buffer) {
    const temp = join(dirname(path), `.rp-${randomUUID()}.tmp`)
    try { await writeFile(temp, bytes, { flag: 'wx', mode: 0o640 }); await rename(temp, path) }
    finally { await rm(temp, { force: true }) }
  }
}

function within(root: string, target: string) { return target === root || target.startsWith(root + sep) }
function isMissing(error: unknown) { return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' }
function decode(bytes: Buffer, partial = false) {
  requireValue(!bytes.includes(0), 'FILE_NOT_TEXT', '这是二进制文件，请预览或下载原件。')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial }) } catch { throw new RpError('FILE_NOT_TEXT', '文件不是 UTF-8 文本，请通过 Bash 转换后读取。') }
}
function hash(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex') }
