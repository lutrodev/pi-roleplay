import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export function developmentPorts(api = '18768', web = '18767') {
  const values = [api, web].map(value => {
    if (!/^\d+$/.test(value)) throw new Error('端口必须是整数。')
    const port = Number(value)
    if (port < 1024 || port > 65535 || port === 3080) throw new Error('调试端口必须为 1024–65535，且不能使用 3080。')
    return port
  })
  if (values[0] === values[1]) throw new Error('前端和 API 不能使用同一端口。')
  return { api: values[0]!, web: values[1]! }
}

export async function assertPortAvailable(port: number) {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  } catch { throw new Error(`端口 ${port} 已被占用或无法监听。请使用 --api-port / --web-port 选择空闲端口；不会停止已有服务。`) }
  finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) }
}

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`调试目录必须是普通目录：${path}`)
  await chmod(path, 0o700)
}

export async function writePrivate(path: string, content: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
  if (info && !info.isFile()) throw new Error('调试文件不能是符号链接或特殊文件：' + path)
  const temporary = path + '.tmp-' + randomBytes(6).toString('hex')
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(content); await handle.sync() }
    finally { await handle.close() }
    await rename(temporary, path)
  }
  finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }) }
}

async function secretFile(path: string, create: () => Buffer, validate: (bytes: Buffer) => boolean) {
  let handle
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(create())
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  finally { await handle?.close() }
  const reader = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await reader.stat()
    if (!info.isFile() || info.size > 512) throw new Error('调试密钥文件无效。')
    const bytes = await reader.readFile()
    if (!validate(bytes)) throw new Error('调试密钥文件无效；不会覆盖现有密钥。')
    await reader.chmod(0o600)
    return bytes
  } finally { await reader.close() }
}

export async function prepareDevelopment(directory: string) {
  await privateDirectory(directory)
  for (const child of ['data', 'data/inputs', 'workspaces', 'skills']) await privateDirectory(join(directory, child))
  await secretFile(join(directory, 'session_key'), () => randomBytes(32), bytes => bytes.length === 32)
  await secretFile(join(directory, 'tool_token'), () => Buffer.from(randomBytes(48).toString('base64url')), bytes => /^[\w-]{32,256}$/.test(bytes.toString()))
  // Compose bind-file secrets keep the host mode; the container uses this same non-root uid.
}

export function developmentEnvironment(directory: string, api: number, web: number, toolsUrl: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RP_') && !key.startsWith('COMPOSE_')))
  return { ...env, NODE_ENV: 'development', RP_HOST: '127.0.0.1', RP_PORT: String(api), RP_PUBLIC_ORIGIN: `http://127.0.0.1:${web}`,
    RP_DATA_DIR: join(directory, 'data'), RP_SESSION_KEY_FILE: join(directory, 'session_key'), RP_TOOL_TOKEN_FILE: join(directory, 'tool_token'),
    RP_TOOLS_URL: toolsUrl, RP_CUSTOM_SKILLS_DIR: join(directory, 'skills'), RP_DEV_API_PORT: String(api), RP_DEV_WEB_PORT: String(web),
  }
}

export async function run(executable: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; capture?: boolean; input?: string; signal?: AbortSignal }) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, signal: options.signal,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', options.capture ? 'pipe' : 'inherit', options.capture ? 'pipe' : 'inherit'] })
    let output = ''
    child.stdout?.on('data', chunk => { output = (output + chunk).slice(-65536) })
    child.stderr?.on('data', chunk => { output = (output + chunk).slice(-65536) })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${executable} ${args[0] ?? ''} 执行失败（${code}）。${options.capture ? '\n' + output.trim() : '请检查上方日志。'}`)))
    child.stdin?.end(options.input)
  })
}

export async function stopProcess(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal) } catch { child.kill(signal) } }
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => kill('SIGKILL'), 12_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    kill('SIGTERM')
  })
}
