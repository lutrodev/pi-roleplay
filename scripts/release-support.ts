import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdir, readFile, lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { approvedMedia, publicationScope, skipDirectory } from './release-policy.ts'

export interface Finding { path: string; rule: string; line?: number }
export interface PublicFile { path: string; content: Buffer; mode: number }
export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export function scanText(path: string, content: string, knownSecrets: string[] = []): Finding[] {
  const rules: [string, RegExp][] = [
    ['private-key', /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/],
    ['provider-token', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AIza[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16})\b/],
    ['personal-path', /\/(?:Users|home)\/(?!rp(?:\/|$))[A-Za-z0-9_.-]+\//],
    ['temporary-personal-path', /\/var\/folders\/[A-Za-z0-9_/-]+/],
  ]
  const findings: Finding[] = []
  content.split('\n').forEach((line, index) => {
    for (const [rule, pattern] of rules) if (pattern.test(line)) findings.push({ path, rule, line: index + 1 })
    for (const match of line.matchAll(/https?:\/\/[^\s/:"']+:[^\s/@"']+@[^\s"')]+/g)) {
      try {
        const url = new URL(match[0])
        const fixture = path.startsWith('tests/') && url.hostname.endsWith('.test') && url.username === 'user' && ['secret', 'password'].includes(url.password)
        if (!fixture) findings.push({ path, rule: 'credential-in-url', line: index + 1 })
      } catch { findings.push({ path, rule: 'credential-in-url', line: index + 1 }) }
    }
    if (knownSecrets.some(value => value.length >= 16 && line.includes(value))) findings.push({ path, rule: 'local-secret-copy', line: index + 1 })
    const assignment = /(?:api[_-]?key|password|secret|token)\s*[=:]\s*["']([A-Za-z0-9_+\/=.-]{24,})["']/ig
    for (const match of line.matchAll(assignment)) {
      const value = match[1]!
      if (/^(?:synthetic-|browser-|test-|fixture-|example-)/.test(value)) continue
      if (path.startsWith('tests/') && /-(?:synthetic|fixture)-(?:password|token|key)$/.test(value)) continue
      // Non-secret deterministic test text has very little character variety.
      if (new Set(value).size > 12) findings.push({ path, rule: 'credential-literal', line: index + 1 })
    }
  })
  return findings
}

async function localSecrets(root: string) {
  const values: string[] = []
  // Compare in memory only. Reports contain locations and rule names, never matched values.
  for (const path of ['secrets/models.env', 'secrets/tool_token', '.dev/tool_token', '.dev/admin-password']) {
    const full = join(root, path), info = await lstat(full).catch(() => undefined)
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 262144) continue
    const content = await readFile(full, 'utf8')
    values.push(...(path.endsWith('.env') ? content.split('\n').filter(line => !line.trim().startsWith('#')).map(line => line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')) : [content.trim()]))
  }
  for (const path of ['secrets/session_key', '.dev/session_key']) {
    const full = join(root, path), info = await lstat(full).catch(() => undefined)
    if (info?.isFile() && !info.isSymbolicLink() && info.size === 32) { const value = await readFile(full); values.push(value.toString('hex'), value.toString('base64')) }
  }
  return values.filter(value => value.length >= 16)
}

export async function auditSource(root: string) {
  root = await realpath(root)
  const findings: Finding[] = [], files: PublicFile[] = [], excluded: string[] = [], secrets = await localSecrets(root)
  async function walk(directory = '') {
    for (const item of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = directory ? directory + '/' + item.name : item.name
      if (skipDirectory(path)) { excluded.push(path + '/'); continue }
      if (item.isDirectory()) { await walk(path); continue }
      const scope = publicationScope(path)
      if (scope === 'local') { excluded.push(path); continue }
      if (scope === 'unreviewed') { findings.push({ path, rule: 'unreviewed-file' }); continue }
      if (!item.isFile()) { findings.push({ path, rule: 'symlink-or-special-file' }); continue }
      const info = await lstat(join(root, path))
      if (info.size > 5_000_000) { findings.push({ path, rule: 'oversized-source-file' }); continue }
      const content = await readFile(join(root, path))
      if (approvedMedia[path]) {
        if (digest(content) !== approvedMedia[path]) findings.push({ path, rule: 'media-provenance-changed' })
      } else {
        try { findings.push(...scanText(path, new TextDecoder('utf-8', { fatal: true }).decode(content), secrets)) }
        catch { findings.push({ path, rule: 'unreviewed-binary' }) }
      }
      files.push({ path, content, mode: path.endsWith('.sh') ? 0o755 : 0o644 })
    }
  }
  await walk()
  const names = new Set(files.map(file => file.path))
  for (const required of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'pnpm-lock.yaml', 'dev.sh', 'deploy.sh', 'docs/development.md', 'docs/deployment.md', 'docs/open-source.md']) if (!names.has(required)) findings.push({ path: required, rule: 'missing-public-file' })
  for (const file of files.filter(file => file.path.endsWith('.md'))) {
    for (const link of file.content.toString().matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = link[1]!.replace(/^<|>$/g, '').split('#')[0]!
      if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue
      const path = posix.normalize(posix.join(dirname(file.path), decodeURIComponent(target)))
      if (!names.has(path) && !files.some(item => item.path.startsWith(path.replace(/\/$/, '') + '/'))) findings.push({ path: file.path, rule: 'link-to-unpublished-file' })
    }
  }
  let git = 'absent'
  const hasGitMetadata = Boolean(await lstat(join(root, '.git')).catch(() => undefined))
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (resolve(top) === resolve(root)) {
      git = 'index-and-history-scanned'
      const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
      for (const path of tracked) if (publicationScope(path) !== 'public') findings.push({ path, rule: 'private-file-tracked-by-git' })
      const objects = execFileSync('git', ['-C', root, 'rev-list', '--objects', '--all'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n').filter(Boolean)
      // Historical deleted files matter too. Read each blob without echoing contents.
      for (const object of objects) {
        const at = object.indexOf(' ')
        if (at < 0) continue
        const id = object.slice(0, at), path = object.slice(at + 1)
        const type = execFileSync('git', ['-C', root, 'cat-file', '-t', id], { encoding: 'utf8' }).trim()
        if (type !== 'blob') continue
        if (publicationScope(path) !== 'public') { findings.push({ path, rule: 'private-file-in-git-history' }); continue }
        const bytes = execFileSync('git', ['-C', root, 'cat-file', 'blob', id], { maxBuffer: 8 * 1024 * 1024 })
        if (approvedMedia[path]) { if (digest(bytes) !== approvedMedia[path]) findings.push({ path, rule: 'unreviewed-historical-media' }) }
        else findings.push(...scanText(path, bytes.toString('utf8'), secrets).map(item => ({ ...item, rule: 'history-' + item.rule })))
      }
      // The index may differ from the working tree being packed.
      for (const path of tracked.filter(path => publicationScope(path) === 'public' && !approvedMedia[path])) {
        const bytes = execFileSync('git', ['-C', root, 'show', ':' + path], { maxBuffer: 8 * 1024 * 1024 })
        findings.push(...scanText(path, bytes.toString('utf8'), secrets).map(item => ({ ...item, rule: 'index-' + item.rule })))
      }
    }
  } catch (error) {
    if (git !== 'absent' || hasGitMetadata) findings.push({ path: '.git', rule: 'git-audit-incomplete' })
  }
  const user = basename(homedir())
  if (user.length > 3 && !['root', 'runner', 'user'].includes(user)) for (const file of files.filter(file => !approvedMedia[file.path])) {
    if (file.content.toString().includes(user + '@')) findings.push({ path: file.path, rule: 'local-account-email' })
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), findings, excluded, git }
}

export function sourceArchive(files: PublicFile[]) {
  const buffers: Buffer[] = []
  for (const file of files) {
    const path = 'pi-roleplay/' + file.path
    const split = Buffer.byteLength(path) > 100 ? path.lastIndexOf('/') : -1
    const name = split >= 0 ? path.slice(split + 1) : path, prefix = split >= 0 ? path.slice(0, split) : ''
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('源码路径超过 tar 格式限制：' + file.path)
    const header = Buffer.alloc(512)
    const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0'
    header.write(name, 0, 100); header.write(octal(file.mode, 8), 100); header.write(octal(0, 8), 108); header.write(octal(0, 8), 116)
    header.write(octal(file.content.length, 12), 124); header.write(octal(0, 12), 136); header.fill(32, 148, 156)
    header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263); header.write(prefix, 345, 155)
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    buffers.push(header, file.content, Buffer.alloc((512 - file.content.length % 512) % 512))
  }
  buffers.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(buffers), { level: 9 })
}
