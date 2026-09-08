import { parseArgs } from 'node:util'
import { resolve, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { AuthService } from './services/auth-service.ts'
import { AssetRepository } from './storage/asset-repository.ts'
import { AppDatabase } from './storage/database.ts'
import { RpError, requireValue } from '../../../packages/rp-core/src/errors.ts'

export async function runAdmin(args: string[], input: AsyncIterable<Buffer | string>, env: NodeJS.ProcessEnv = process.env) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    'data-dir': { type: 'string' }, 'password-stdin': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } })
  if (values.help) return '用法：pnpm admin set-password --password-stdin [--data-dir ./data]\n从标准输入读取密码；支持首次初始化与重置。重置会撤销现有登录。'
  requireValue(positionals.length === 1 && positionals[0] === 'set-password' && values['password-stdin'], 'INVALID_COMMAND', '请使用 set-password --password-stdin，通过标准输入提供密码。')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    requireValue(size <= 4096, 'INVALID_PASSWORD', '密码输入过长。')
    chunks.push(bytes)
  }
  const password = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, '')
  const directory = resolve(values['data-dir'] ?? env.RP_DATA_DIR ?? './data')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const database = new AppDatabase(join(directory, 'app.sqlite'))
  try { await new AuthService(new AssetRepository(database)).setPassword(password) }
  finally { database.close() }
  return '管理员密码已保存，现有登录已撤销。'
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077)
  runAdmin(process.argv.slice(2), process.stdin).then(message => process.stdout.write(message + '\n')).catch(error => {
    process.stderr.write((error instanceof RpError ? error.message : '管理命令执行失败，请检查参数和数据目录。') + '\n')
    process.exitCode = 1
  })
}
