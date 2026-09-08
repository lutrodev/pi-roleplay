/** Real Docker acceptance of the public source tree and deployment entry points; synthetic data only. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, realpath, mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditSource } from './release-support.ts'

const root = fileURLToPath(new URL('..', import.meta.url)), base = await realpath(await mkdtemp(join(tmpdir(), 'rp-entrypoint-')))
const targets: { path: string; project: string }[] = [], passed: string[] = []
const proxyContainers: string[] = [], proxyNetworks: string[] = []
const proxyImage = 'openresty/openresty:1.29.2.4-1-alpine@sha256:a155a204d5d477d1c695dd10dc53b73e91fc0977e181a95cb5c3e07d4f35f755'
const password = randomBytes(24).toString('base64url')
async function command(executable: string, args: string[], cwd: string, input?: string, fails = false) {
  return await new Promise<string>((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COMPOSE_') && !key.startsWith('RP_')))
    const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    let output = ''
    const keep = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-262144) }
    child.stdout.on('data', keep); child.stderr.on('data', keep)
    const timer = setTimeout(() => { if (child.pid) process.kill(-child.pid, 'SIGKILL'); reject(new Error('Test command timed out: ' + args[0])) }, 600_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      if ((code === 0) !== fails) resolve(output.trim())
      else reject(new Error(output.replaceAll(password, '[redacted]').slice(-8000)))
    })
    child.stdin.end(input)
  })
}
async function port() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const value = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return value
}
const dc = async (path: string, ...args: string[]) => {
  const env = await readFile(join(path, '.env'), 'utf8')
  const overlay = /^RP_PROXY_NETWORK=.+$/m.test(env) ? ['-f', join(path, 'deploy/compose.proxy-network.yaml')] : []
  return command('docker', ['compose', '--project-directory', path, '--env-file', join(path, '.env'), '-f', join(path, 'deploy/compose.yaml'), ...overlay, ...args], path)
}
const deploy = (path: string, args: string[], fails = false) => command('python3', ['scripts/deploy.py', ...args], path, args.includes('--password-stdin') ? password + '\n' : undefined, fails)

try {
  const source = await auditSource(root)
  assert.deepEqual(source.findings, [], 'Public source audit must pass before Docker acceptance')
  async function checkout(name: string, mode: 'external' | 'caddy') {
    const path = join(base, name), project = 'rp-entry-' + randomBytes(5).toString('hex')
    for (const file of source.files) { await mkdir(join(path, dirname(file.path)), { recursive: true }); await writeFile(join(path, file.path), file.content, { mode: file.mode }) }
    targets.push({ path, project })
    const http = await port(), https = await port(), application = await port(), origin = `http://127.0.0.1:${http}`
    const network = mode === 'external' ? project + '-proxy' : ''
    if (network) { await command('docker', ['network', 'create', network], path); proxyNetworks.push(network) }
    await deploy(path, ['configure', origin, '--project', project, '--port', String(application), ...(mode === 'caddy' ? ['--caddy'] : ['--proxy-network', network])])
    const env = await readFile(join(path, '.env'), 'utf8')
    await writeFile(join(path, '.env'), env.replace('RP_HTTPS_PORT=443', `RP_HTTPS_PORT=${https}`).replace('RP_APP_IMAGE=pi-roleplay-app:0.1.0', `RP_APP_IMAGE=pi-roleplay-app:${project}`).replace('RP_TOOLS_IMAGE=pi-roleplay-tools:0.1.0', `RP_TOOLS_IMAGE=pi-roleplay-tools:${project}`))
    const compose = await readFile(join(path, 'deploy/compose.yaml'), 'utf8')
    await writeFile(join(path, 'deploy/compose.yaml'), compose.replaceAll('interval: 15s', 'interval: 1s').replaceAll(/start_period: \d+s/g, 'start_period: 1s'))
    return { path, project, origin, http, application, network }
  }
  const sourceDeployment = await checkout('source', 'external'), { path, project, origin, http, application, network } = sourceDeployment
  // An existing proxy starts first. Accidental Caddy activation would collide with its port.
  const location = `location / {
    resolver 127.0.0.11 valid=1s ipv6=off;
    set $rp_upstream http://${project}-app:3091;
    proxy_pass $rp_upstream;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    client_max_body_size 26m;
  }`
  const proxyConfig = join(path, 'proxy-test.conf'), proxyName = project + '-openresty'
  await writeFile(proxyConfig, 'server { listen 80;\n' + location + '\n}\n')
  proxyContainers.push(proxyName)
  await command('docker', ['run', '--detach', '--name', proxyName, '--network', network, '-p', `127.0.0.1:${http}:80`, '--mount', `type=bind,source=${proxyConfig},target=/etc/nginx/conf.d/default.conf,readonly`, proxyImage], path)
  const proxyId = await command('docker', ['inspect', '--format', '{{.Id}}', proxyName], path)
  const rendered = JSON.parse(await dc(path, 'config', '--format', 'json'))
  assert.deepEqual(Object.keys(rendered.services).sort(), ['app', 'tools'])
  console.log('验证：已有 OpenResty 运行时，默认仅启动 app/tools 并开放一个内网入口。')
  await deploy(path, ['install', origin, '--project', project, '--password-stdin'])
  let cookie = ''
  const login = async (url: string) => {
    const response = await fetch(url + '/api/auth/login', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
    assert.equal(response.status, 200); return response.headers.get('set-cookie')!.split(';')[0]!
  }
  cookie = await login(origin)
  const api = async (url: string, method = 'GET', body?: unknown) => {
    const response = await fetch(origin + '/api' + url, { method, headers: { cookie, origin, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value as any
  }
  const workspace = (await api('/workspaces', 'POST', { name: '合成部署工作区', access: 'read-write' })).workspace
  const story = (await api('/stories', 'POST', { title: '部署入口合成验收', workspaceId: workspace.id })).story
  const originalContainers = await dc(path, 'ps', '-q')
  assert.equal(originalContainers.split('\n').length, 2)
  const containers = JSON.parse(await command('docker', ['inspect', ...originalContainers.split('\n')], path))
  const app = containers.find((container: any) => container.Config.Labels['com.docker.compose.service'] === 'app')
  const tools = containers.find((container: any) => container.Config.Labels['com.docker.compose.service'] === 'tools')
  assert.deepEqual(app.HostConfig.PortBindings, { '3091/tcp': [{ HostIp: '127.0.0.1', HostPort: String(application) }] })
  assert.deepEqual(tools.HostConfig.PortBindings, {})
  assert(app.NetworkSettings.Networks[network]); assert(!tools.NetworkSettings.Networks[network])
  assert((await fetch(`http://127.0.0.1:${application}/health`)).ok)
  assert.match(await (await fetch(origin + '/library', { headers: { accept: 'text/html' } })).text(), /<div id="root">/)
  const stream = await fetch(origin + `/api/stories/${story.id}/events`, { headers: { cookie }, signal: AbortSignal.timeout(5000) })
  const reader = stream.body!.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /: connected/); await reader.cancel()
  const upload = new FormData(); upload.append('file', new Blob(['synthetic proxy upload\n'.repeat(60000)], { type: 'text/plain' }), 'proxy-upload.txt')
  assert.equal((await fetch(origin + '/api/files', { method: 'POST', headers: { cookie, origin }, body: upload })).status, 201)
  assert.equal((await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { cookie, origin: 'https://wrong-origin.example.test' } })).status, 403)
  await mkdir(join(root, 'output'), { recursive: true }); await writeFile(join(root, 'output/proxy-browser.json'), JSON.stringify({ origin }) + '\n')
  passed.push('Existing OpenResty → default two-container install → one loopback app port, shared proxy network without tools, login/static/API/SSE/upload and Origin validation')
  assert.match(await deploy(path, ['install', origin, '--project', project, '--password-stdin'], true), /已有应用数据/)
  assert.equal(await dc(path, 'ps', '-q'), originalContainers)
  assert.match(await deploy(path, ['logs', '--tail', '2']), /app|tools|caddy/)

  console.log('验证：构建失败保留旧服务；成功更新保留会话和工作区。')
  const mainPath = join(path, 'apps/web/src/main.tsx'), valid = await readFile(mainPath)
  await writeFile(mainPath, 'invalid syntax ]]]')
  await deploy(path, ['update'], true)
  assert.equal(await dc(path, 'ps', '-q'), originalContainers)
  assert.equal((await api(`/stories/${story.id}`)).story.title, story.title)
  await writeFile(mainPath, valid)
  await deploy(path, ['update'])
  assert.notEqual(await dc(path, 'ps', '-q'), originalContainers)
  cookie = await login(origin)
  assert.equal(await command('docker', ['inspect', '--format', '{{.Id}}', proxyName], path), proxyId)
  assert.equal((await api(`/stories/${story.id}`)).story.title, story.title)
  assert.equal((await api('/workspaces')).workspaces[0].id, workspace.id)
  assert.equal((await api('/system/status')).operations.quiesced, false)
  const updates = join(path, '.deploy/updates')
  const reports = await Promise.all((await readdir(updates)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(updates, name), 'utf8'))))
  const completed = reports.find(report => report.status === 'completed')
  assert(completed); assert.equal(completed.previousImages.app.startsWith('sha256:'), true)
  passed.push('Build failure leaves original containers running; successful update backs up, changes images and resumes with data intact')

  console.log('验证：新版本启动失败停止应用，并从升级前备份恢复到空目录。')
  await writeFile(join(path, 'config/models.json'), '{invalid-json')
  await deploy(path, ['update'], true)
  assert.equal(await dc(path, 'ps', '--status', 'running', '--quiet', 'app', 'tools'), '')
  const finalReports = await Promise.all((await readdir(updates)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(updates, name), 'utf8'))))
  const failed = finalReports.find(report => report.status === 'failed')
  assert(failed?.backup)
  const restored = await checkout('restored', 'caddy')
  let restoredEnv = await readFile(join(restored.path, '.env'), 'utf8')
  restoredEnv = restoredEnv.replace(/^RP_APP_IMAGE=.*$/m, 'RP_APP_IMAGE=' + failed.previousImages.app).replace(/^RP_TOOLS_IMAGE=.*$/m, 'RP_TOOLS_IMAGE=' + failed.previousImages.tools)
  await writeFile(join(restored.path, '.env'), restoredEnv)
  await rm(join(restored.path, 'secrets/session_key'))
  await copyFile(join(path, 'secrets/session_key'), join(restored.path, 'secrets/session_key'))
  await deploy(restored.path, ['restore', join(path, failed.backup)])
  await deploy(restored.path, ['up'])
  const restoredCookie = await login(restored.origin)
  const restoredResponse = await fetch(restored.origin + `/api/stories/${story.id}`, { headers: { cookie: restoredCookie } })
  assert.equal(restoredResponse.status, 200)
  assert.equal((await restoredResponse.json() as any).story.title, story.title)
  assert.equal((await dc(restored.path, 'ps', '-q')).split('\n').length, 3)
  passed.push('Failed startup stops app/tools and records exact previous images; empty-directory restore recovers login and story')
  console.log('验证：可选 Caddy、该模式下的备份，以及切回用户反代后释放 Caddy 端口。')
  const keyBefore = await readFile(join(restored.path, 'secrets/session_key'))
  await deploy(restored.path, ['backup'])
  assert.equal((await dc(restored.path, 'ps', '-q')).split('\n').length, 3)
  const direct = `http://127.0.0.1:${restored.application}`
  await deploy(restored.path, ['proxy', 'external', '--origin', direct])
  await deploy(restored.path, ['up'])
  assert.equal(await dc(restored.path, 'ps', '--all', '--quiet', 'caddy'), '')
  assert.equal((await dc(restored.path, 'ps', '-q')).split('\n').length, 2)
  const switchedCookie = await login(direct)
  assert.equal((await fetch(direct + `/api/stories/${story.id}`, { headers: { cookie: switchedCookie } })).status, 200)
  assert.deepEqual(await readFile(join(restored.path, 'secrets/session_key')), keyBefore)
  assert(await command('docker', ['volume', 'inspect', restored.project + '_caddy_data'], path))
  const released = createServer(); await new Promise<void>((resolve, reject) => { released.once('error', reject); released.listen(restored.http, '127.0.0.1', resolve) }); await new Promise<void>(resolve => released.close(() => resolve()))
  passed.push('Opt-in Caddy serves the restored deployment and survives backup; switching external removes only project Caddy, releases its port and preserves data/keys/certificate volume')
  await mkdir(join(root, 'docs/evidence'), { recursive: true })
  await writeFile(join(root, 'docs/evidence/development-release-entrypoints.json'), JSON.stringify({ testedAt: new Date().toISOString(), passed, limitations: ['Docker Desktop containers and loopback HTTP only; public VPS/ACME and SSH were not exercised.', 'Fixture Compose uses one-second health sampling.'] }, null, 2) + '\n')
  console.log('全部入口验收通过。')
} finally {
  for (const container of proxyContainers.reverse()) await command('docker', ['rm', '--force', container], root).catch(() => undefined)
  for (const target of targets.reverse()) await dc(target.path, '--profile', 'caddy', 'down', '--volumes', '--remove-orphans').catch(() => undefined)
  for (const network of proxyNetworks.reverse()) await command('docker', ['network', 'rm', network], root).catch(() => undefined)
  await rm(base, { recursive: true, force: true })
}
