import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import { publicationScope, skipDirectory } from '../scripts/release-policy.ts'
import { auditSource, scanText, sourceArchive } from '../scripts/release-support.ts'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() { const path = await mkdtemp(join(tmpdir(), 'rp-release-check-')); directories.push(path); return path }

it('keeps private data, custom skills, credentials and historical evidence outside public scope', () => {
  for (const path of ['.env', '.env.local', '.env.example.local', 'deploy/.env.example', '.dev/data/app.sqlite', 'secrets/models.env', 'state/app/avatar.png', 'docs/evidence/screenshots/a.png', 'docs/migration.md', 'output/report.json', 'skills/custom/private/SKILL.md']) expect(publicationScope(path)).toBe('local')
  for (const path of ['apps/web/output/design/preview/index.html', 'apps/web/output/design/preview/assets/logo.svg']) expect(publicationScope(path)).toBe('local')
  expect(skipDirectory('apps/web/output')).toBe(true)
  expect(publicationScope('apps/web/src/app.tsx')).toBe('public')
  expect(publicationScope('.env.example')).toBe('public')
  expect(publicationScope('skills/custom/.gitkeep')).toBe('public')
  expect(publicationScope('apps/web/public/community-card.png')).toBe('unreviewed')
})

it('ignores root runtime data without hiding domain state source or tests from Git', async () => {
  const root = await fixture()
  execFileSync('git', ['-C', root, 'init', '-q'])
  await writeFile(join(root, '.gitignore'), await readFile(new URL('../.gitignore', import.meta.url)))
  await writeFile(join(root, '.gitattributes'), await readFile(new URL('../.gitattributes', import.meta.url)))
  const privatePaths = ['.env', '.env.local', '.env.example.local', 'state/app.sqlite', '.dev/data/app.sqlite', 'secrets/models.env']
  const publicPaths = ['.env.example', 'packages/rp-core/src/state/update.js', 'packages/rp-core/test/state/update.test.js']
  const paths = [...privatePaths, ...publicPaths]
  const ignored = execFileSync('git', ['-C', root, 'check-ignore', '--stdin', '-z'], { input: paths.join('\0') + '\0', encoding: 'utf8' }).split('\0').filter(Boolean)
  expect(ignored).toEqual(privatePaths)
  for (const path of publicPaths) expect(publicationScope(path)).toBe('public')
  const exported = execFileSync('git', ['-C', root, 'check-attr', 'export-ignore', '--', '.env', '.env.local', '.env.example.local', '.env.example'], { encoding: 'utf8' }).trim().split('\n')
  expect(exported).toEqual(['.env: export-ignore: set', '.env.local: export-ignore: set', '.env.example.local: export-ignore: set', '.env.example: export-ignore: unset'])
})

it('finds credentials without including their values in diagnostics', () => {
  const token = ['sk', 'x'.repeat(35)].join('-'), privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join(''), accountPath = ['/', 'Users', '/', 'private-person', '/project'].join('')
  const findings = scanText('example.ts', `${token}\n${privateKey}\n${accountPath}\nknown-sensitive-local-secret`, ['known-sensitive-local-secret'])
  expect(findings.map(item => item.rule)).toEqual(['provider-token', 'private-key', 'personal-path', 'local-secret-copy'])
  expect(JSON.stringify(findings)).not.toContain(token)
  expect(JSON.stringify(findings)).not.toContain('private-person')
  expect(scanText('test.ts', "const password = 'synthetic-deployment-password'")).toEqual([])
})

it('rejects symlinks, unreviewed media and references to excluded files, while scanning actual local-secret copies', async () => {
  const root = await fixture()
  await mkdir(join(root, 'apps'), { recursive: true }); await mkdir(join(root, 'secrets'))
  await writeFile(join(root, 'secrets/tool_token'), 'private-local-token-for-audit')
  await writeFile(join(root, 'apps/leak.ts'), 'private-local-token-for-audit')
  await writeFile(join(root, 'README.md'), '[internal](docs/evidence/private.md)')
  await writeFile(join(root, 'apps/photo.png'), 'unreviewed')
  await symlink(join(root, 'apps/leak.ts'), join(root, 'apps/link.ts'))
  const result = await auditSource(root)
  expect(result.findings).toEqual(expect.arrayContaining([
    { path: 'apps/leak.ts', rule: 'local-secret-copy', line: 1 }, { path: 'apps/link.ts', rule: 'symlink-or-special-file' },
    { path: 'apps/photo.png', rule: 'unreviewed-file' }, { path: 'README.md', rule: 'link-to-unpublished-file' },
  ]))
  expect(result.files.some(file => file.path.startsWith('secrets/'))).toBe(false)
})

it('inspects Git history after sensitive files have been deleted and ignored', async () => {
  const root = await fixture(), git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.name', 'Synthetic Test'); git('config', 'user.email', 'test@example.test')
  await writeFile(join(root, '.env'), 'PRIVATE_VALUE=synthetic-history-value\n')
  git('add', '.env'); git('commit', '-qm', 'synthetic fixture')
  git('rm', '.env'); git('commit', '-qm', 'remove private file')
  await writeFile(join(root, '.gitignore'), '.env\n')
  const result = await auditSource(root)
  expect(result.git).toBe('index-and-history-scanned')
  expect(result.findings).toContainEqual({ path: '.env', rule: 'private-file-in-git-history' })
  expect(JSON.stringify(result.findings)).not.toContain('synthetic-history-value')
})

it('creates a portable source archive with executable scripts and no owner metadata', async () => {
  const root = await fixture(), archive = sourceArchive([{ path: 'dev.sh', content: Buffer.from('#!/bin/sh\n'), mode: 0o755 }, { path: 'README.md', content: Buffer.from('public\n'), mode: 0o644 }])
  const path = join(root, 'source.tar.gz'); await writeFile(path, archive)
  expect(execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).trim().split('\n')).toEqual(['pi-roleplay/dev.sh', 'pi-roleplay/README.md'])
  execFileSync('tar', ['-xzf', path, '-C', root])
  expect(await readFile(join(root, 'pi-roleplay/README.md'), 'utf8')).toBe('public\n')
  const header = gunzipSync(archive).subarray(0, 512)
  expect(header.subarray(265, 329).every(byte => byte === 0)).toBe(true)
  expect(header.toString('ascii', 100, 107)).toBe('0000755')
})
