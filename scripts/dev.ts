import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { open, readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as pause } from 'node:timers/promises'
import { assertPortAvailable, developmentEnvironment, developmentPorts, prepareDevelopment, privateDirectory, writePrivate, run, stopProcess } from './dev-support.ts'

const root = fileURLToPath(new URL('..', import.meta.url)), directory = join(root, '.dev')
const help = `用法：./dev.sh [--api-port 18768] [--web-port 18767] [--check]
      ./dev.sh password

首次自动安装锁定依赖、生成独立调试数据和密码、构建工具容器。
前端热更新，后端源码变更自动重启；Ctrl+C 停止本次调试，数据保留在 .dev/。
password 重置调试管理员密码，新的密码仅写入 .dev/admin-password。
--check 只检查 Node、pnpm、Docker 和端口，不启动服务。
本入口不会使用生产 .env、state/ 或 secrets/。`

async function main() {
  const { values, positionals } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, check: { type: 'boolean' }, 'api-port': { type: 'string' }, 'web-port': { type: 'string' } }, allowPositionals: true })
  if (values.help) { console.log(help); return }
  if (positionals.length > 1 || positionals.length === 1 && positionals[0] !== 'password') throw new Error(help)
  if (positionals.length && values.check) throw new Error('password 与 --check 不能同时使用。')
  if (process.versions.node.split('.')[0] !== '24') throw new Error('请使用 Node.js 24；版本要求见 package.json。')
  if (!['darwin', 'linux'].includes(process.platform) || !process.getuid?.()) throw new Error('本地调试支持 macOS / Linux 的普通用户。Windows 请在 WSL2 中运行。')
  const ports = developmentPorts(values['api-port'], values['web-port'])
  const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { packageManager: string }
  const pnpmVersion = await run('pnpm', ['--version'], { cwd: root, capture: true })
  if (`pnpm@${pnpmVersion}` !== packageInfo.packageManager) throw new Error(`请安装 ${packageInfo.packageManager}，当前是 pnpm@${pnpmVersion}。`)
  if (!positionals.length) {
    await run('docker', ['info', '--format', '{{.ServerVersion}}'], { cwd: root, capture: true })
    await run('docker', ['compose', 'version', '--short'], { cwd: root, capture: true })
    await Promise.all([assertPortAvailable(ports.api), assertPortAvailable(ports.web)])
  }
  if (values.check) { console.log(`检查通过。前端 ${ports.web} / API ${ports.api} 可用；Docker 可连接。`); return }
  await privateDirectory(directory)
  const lockPath = join(directory, 'launcher.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const old = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number }
    if (!Number.isSafeInteger(old.pid) || old.pid <= 1) throw new Error('调试锁文件无效，请检查 .dev/launcher.lock。')
    let active = true
    try { process.kill(old.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') active = false }
    if (active) throw new Error(`已有调试进程（PID ${old.pid}）。先在原终端 Ctrl+C；不会停止其他进程。`)
    await unlink(lockPath)
    lock = await open(lockPath, 'wx', 0o600)
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid }))
  const controller = new AbortController(), children: ChildProcess[] = []
  const env = developmentEnvironment(directory, ports.api, ports.web, 'http://127.0.0.1:1')
  const project = 'rp-dev-' + createHash('sha256').update(root).digest('hex').slice(0, 12)
  const composeEnv = { ...env, RP_DEV_UID: String(process.getuid!()), RP_DEV_GID: String(process.getgid!()), RP_DEV_TOOLS_IMAGE: `pi-roleplay-tools:${project}` }
  const composeArgs = ['compose', '--project-directory', root, '--env-file', join(directory, 'compose.env'), '-p', project, '-f', join(root, 'deploy/compose.dev.yaml')]
  const dc = (args: string[], capture = false, signal?: AbortSignal) => run('docker', [...composeArgs, ...args], { cwd: root, env: composeEnv, capture, signal })
  let toolsStarted = false, failure: Error | undefined
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try {
    await prepareDevelopment(directory)
    await writePrivate(join(directory, 'compose.env'), '# Managed development configuration; no production values.\n')
    const installHash = createHash('sha256').update(await readFile(join(root, 'pnpm-lock.yaml'))).update(await readFile(join(root, 'package.json'))).update(await readFile(join(root, 'pnpm-workspace.yaml'))).update(process.versions.node).update(process.platform).update(process.arch).digest('hex')
    const stamp = join(directory, 'dependencies.sha256')
    if ((await readFile(stamp, 'utf8').catch(() => '')) !== installHash || !existsSync(join(root, 'node_modules/tsx/package.json'))) {
      console.log('安装当前锁文件中的依赖…')
      await run('pnpm', ['install', '--frozen-lockfile'], { cwd: root, env, signal: controller.signal })
      await writePrivate(stamp, installHash)
    }
    if (positionals[0] === 'password' || !existsSync(join(directory, 'data/app.sqlite'))) {
      const password = randomBytes(24).toString('base64url')
      await run(process.execPath, ['--import', 'tsx', 'apps/server/src/cli.ts', 'set-password', '--password-stdin'], { cwd: root, env, input: password + '\n', signal: controller.signal })
      await writePrivate(join(directory, 'admin-password'), password + '\n')
    }
    if (positionals.length) { console.log('调试密码已重置。使用 cat .dev/admin-password 查看；生产密码未改变。'); return }
    console.log('构建并启动专用工具容器（Docker 缓存会复用未改变的层）…')
    await dc(['build', 'tools'], false, controller.signal)
    toolsStarted = true
    await dc(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90'], false, controller.signal)
    const address = await dc(['port', 'tools', '3092'], true, controller.signal)
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('工具服务没有绑定预期的本机地址。')
    env.RP_TOOLS_URL = `http://${address}`
    const launch = (name: string, args: string[]) => {
      const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', detached: true })
      children.push(child)
      child.once('error', error => { failure = error; controller.abort() })
      child.once('exit', code => { if (!controller.signal.aborted) { failure = new Error(`${name} 已退出（${code}）；停止本次调试。`); controller.abort() } })
      return child
    }
    const waitForHealth = async (port: number) => {
      const deadline = Date.now() + 45_000
      while (true) {
        controller.signal.throwIfAborted()
        const healthy = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok, () => false)
        if (healthy) return
        if (Date.now() >= deadline) throw new Error(`端口 ${port} 的服务未能在 45 秒内就绪，请检查上方错误。`)
        await pause(300, undefined, { signal: controller.signal })
      }
    }
    launch('API', ['--watch', '--watch-preserve-output', '--import', 'tsx', 'apps/server/src/main.ts'])
    await waitForHealth(ports.api)
    const require = createRequire(import.meta.url)
    launch('Vite', [resolve(require.resolve('vite/package.json'), '../bin/vite.js'), '--host', '127.0.0.1'])
    await waitForHealth(ports.web)
    console.log(`\n调试已就绪：http://127.0.0.1:${ports.web}\n初始密码：在另一个终端运行 cat .dev/admin-password\nAPI：http://127.0.0.1:${ports.api}；数据：.dev/；Ctrl+C 停止，数据保留。\n`)
    await new Promise<void>(resolve => { if (controller.signal.aborted) resolve(); else controller.signal.addEventListener('abort', () => resolve(), { once: true }) })
  } catch (error) { if (!controller.signal.aborted) failure = error instanceof Error ? error : new Error(String(error)) }
  finally {
    controller.abort()
    for (const child of children.reverse()) await stopProcess(child)
    if (toolsStarted) try { await dc(['down', '--timeout', '15']) } catch (error) { failure ??= new Error(`调试容器清理失败：${String(error)}`) }
    await lock.close(); await unlink(lockPath)
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel)
  }
  if (failure) throw failure
}

main().catch(error => { console.error(error instanceof Error ? error.message : '调试启动失败。'); process.exitCode = 1 })
