// Operator-only one-shot container. No model keys, network, or Docker socket are mounted.
import { chmod, chown, lchown, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import Database from 'better-sqlite3'

process.umask(0o077)
const [command, name, uid, gid] = process.argv.slice(2)
const run = args => { const result = spawnSync('tar', args, { stdio: 'inherit' }); if (result.status !== 0) throw new Error('Archive operation failed') }
function databaseCheck(checkpoint = false) {
  const database = new Database('/state/app/app.sqlite', { readonly: !checkpoint, fileMustExist: true })
  try {
    if (database.pragma('integrity_check', { simple: true }) !== 'ok' || database.pragma('foreign_key_check').length) throw new Error('SQLite integrity check failed')
    if (checkpoint && database.pragma('wal_checkpoint(TRUNCATE)')[0].busy !== 0) throw new Error('Database is still busy')
  } finally { database.close() }
}
async function empty(path) { await mkdir(path, { recursive: true }); if ((await readdir(path)).length) throw new Error('Restore target is not empty: ' + path) }
async function own(path) {
  const info = await lstat(path)
  await lchown(path, 10001, 10001)
  if (info.isDirectory()) { for (const file of await readdir(path)) await own(join(path, file)) }
}
try {
  if (process.getuid?.() !== 0) throw new Error('Run the operator helper as root inside its one-shot container')
  if (command === 'init') {
    for (const path of ['/state/app', '/state/app/inputs', '/state/workspaces']) {
      await mkdir(path, { recursive: true, mode: 0o700 }); await chown(path, 10001, 10001); await chmod(path, 0o700)
    }
  } else if (command === 'pack') {
    if (!/^rp-[0-9TZ-]+\.tar\.gz\.partial$/.test(name ?? '') || !/^\d+$/.test(uid ?? '') || !/^\d+$/.test(gid ?? '')) throw new Error('Invalid backup arguments')
    databaseCheck(true)
    run(['--create', '--gzip', '--file', '/backup/' + name, '--directory', '/state', '--exclude=app/admin.sock', '--exclude=app/maintenance.lock', 'app', 'workspaces'])
    await chown('/backup/' + name, Number(uid), Number(gid)); await chmod('/backup/' + name, 0o600)
  } else if (command === 'restore') {
    await empty('/state/app'); await empty('/state/workspaces')
    run(['--extract', '--gzip', '--file', '/archive/backup.tar.gz', '--directory', '/state', '--no-same-owner', '--no-same-permissions'])
    databaseCheck()
    for (const path of ['/state/app', '/state/workspaces']) { await own(path); await chmod(path, 0o700) }
    await rm('/state/app/maintenance.lock', { force: true }); await rm('/state/app/admin.sock', { force: true })
  } else if (command === 'record') {
    const chunks = []; for await (const chunk of process.stdin) { chunks.push(chunk); if (Buffer.concat(chunks).length > 8192) throw new Error('Status too large') }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const file = '/state/app/backup-status.json', temporary = file + '.tmp'
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 }); await chown(temporary, 10001, 10001); await rename(temporary, file)
  } else throw new Error('Unknown data operation')
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
