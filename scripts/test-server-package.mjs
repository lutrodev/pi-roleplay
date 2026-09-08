import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKGROUND_PRESETS } from '../packages/protocol/src/backgrounds.ts'

const root = fileURLToPath(new URL('../', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'rp-server-package-'))
let server
const command = (executable, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], ...options })
  let output = ''
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-30000) })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-30000) })
  const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Package verification command timed out')) }, 120000)
  child.on('error', error => { clearTimeout(timeout); reject(error) })
  child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve(output) : reject(new Error(`Command failed (${code}): ${output}`)) })
  child.stdin.end(options.input)
})
async function freePort() {
  const listener = createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  return port
}
async function internalLinks(path, boundary) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const current = join(path, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await realpath(current), inside = relative(boundary, target)
      assert(!inside.startsWith('..' + sep) && inside !== '..', `Package symlink escapes deployment: ${relative(boundary, current)}`)
    } else if (entry.isDirectory()) await internalLinks(current, boundary)
  }
}

try {
  await command(process.execPath, ['scripts/build-server.mjs'])
  const deployment = join(directory, 'app')
  await command('pnpm', ['--filter', '@pi-roleplay/server', 'deploy', '--prod', deployment])
  await internalLinks(deployment, await realpath(deployment))
  const manifest = JSON.parse(await readFile(join(deployment, 'package.json'), 'utf8'))
  assert(!manifest.dependencies.react && !manifest.dependencies['node-pty'])
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    assert.equal(await readFile(join(deployment, 'dist', name), 'utf8'), await readFile(join(root, name), 'utf8'), `Missing or changed package notice: ${name}`)
  }
  console.log('通过：服务端包和依赖均位于独立目录，不含 React 或 shell 执行依赖。')
  const data = join(directory, 'data'), custom = join(directory, 'custom'), builtin = join(directory, 'builtin')
  await mkdir(custom); await cp(join(root, 'skills/builtin'), builtin, { recursive: true })
  await writeFile(join(directory, 'session.key'), randomBytes(32), { mode: 0o600 })
  await writeFile(join(directory, 'tool.token'), randomBytes(32).toString('base64url'), { mode: 0o600 })
  const port = await freePort(), origin = `http://127.0.0.1:${port}`
  const env = { PATH: process.env.PATH, RP_PUBLIC_ORIGIN: origin, RP_PORT: String(port), RP_HOST: '127.0.0.1', RP_DATA_DIR: data,
    RP_SESSION_KEY_FILE: join(directory, 'session.key'), RP_TOOL_TOKEN_FILE: join(directory, 'tool.token'),
    RP_BUILTIN_SKILLS_DIR: builtin, RP_CUSTOM_SKILLS_DIR: custom, RP_TOOLS_URL: 'http://127.0.0.1:1' }
  const password = 'synthetic-' + randomBytes(16).toString('hex')
  const initialized = await command(process.execPath, ['dist/cli.js', 'set-password', '--password-stdin'], { cwd: deployment, env, input: password + '\n' })
  assert(!initialized.includes(password))
  let logs = '', exited = false
  server = spawn(process.execPath, ['dist/main.js'], { cwd: deployment, env, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-30000) }); server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-30000) })
  server.once('exit', () => { exited = true })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    assert(!exited, `Packaged server exited: ${logs}`)
    ready = await fetch(origin + '/health').then(response => response.ok, () => false)
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert(ready, 'Packaged server did not become ready')
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const created = await fetch(origin + '/api/stories', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: '独立部署验证' }) })
  assert.equal(created.status, 201)
  const story = (await created.json()).story
  assert(story.profile.resources.preset)
  const settings = await (await fetch(origin + '/api/settings', { headers: { cookie } })).json()
  assert.equal(settings.preferences.reading.fontSize, 16)
  const backgroundPath = origin + '/api/settings/backgrounds'
  const library = await (await fetch(backgroundPath, { headers: { cookie } })).json()
  assert.deepEqual(library.images, [])
  const image = new FormData()
  image.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNwLG9xLG9hgFAAIZIE8QMqECIAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'synthetic-background.png')
  const uploaded = await fetch(backgroundPath + '?expectedRevision=' + library.revision, { method: 'POST', headers: { origin, cookie }, body: image })
  assert.equal(uploaded.status, 201)
  const background = await uploaded.json()
  const applied = await fetch(backgroundPath, { method: 'PUT', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: background.revision, selectedId: background.uploadedId, intensity: 25 }) })
  assert.equal(applied.status, 200)
  assert.equal((await applied.json()).selectedId, background.uploadedId)
  for (const suffix of ['', '?thumbnail=true']) {
    const content = await fetch(`${backgroundPath}/${background.uploadedId}/content${suffix}`, { headers: { cookie } })
    assert.equal(content.headers.get('content-type'), 'image/webp')
    assert.equal(Buffer.from(await content.arrayBuffer()).subarray(8, 12).toString(), 'WEBP')
  }
  const savedBackground = await (await fetch(backgroundPath, { headers: { cookie } })).json()
  const preset = BACKGROUND_PRESETS[0]
  const selectedPreset = await fetch(backgroundPath, { method: 'PUT', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: savedBackground.revision, selectedId: preset.id, intensity: 18 }) })
  assert.equal(selectedPreset.status, 200)
  assert.equal((await selectedPreset.json()).selectedId, preset.id)
  for (const image of BACKGROUND_PRESETS) {
    for (const thumbnail of [false, true]) {
      const content = await fetch(`${backgroundPath}/${image.id}/content${thumbnail ? '?thumbnail=true' : ''}`, { headers: { cookie } })
      assert.equal(content.status, 200)
      assert.deepEqual(Buffer.from(await content.arrayBuffer()), await readFile(join(deployment, 'dist/backgrounds', `${image.slug}${thumbnail ? '.thumb' : ''}.webp`)))
    }
  }
  const skills = await (await fetch(origin + '/api/settings/skills', { headers: { cookie } })).json()
  assert.equal(skills.skills.length, 7)
  const reset = await command(process.execPath, ['dist/cli.js', 'set-password', '--password-stdin'], { cwd: deployment, env, input: password + '-reset\n' })
  assert(!reset.includes(password))
  assert.equal((await fetch(origin + '/api/stories', { headers: { cookie } })).status, 401)
  server.kill('SIGTERM')
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(new Error('Server did not stop gracefully')), 5000); server.once('exit', code => { clearTimeout(deadline); code === 0 ? resolve() : reject(new Error('Server shutdown failed')) }) })
  server = undefined
  assert(!logs.includes(password))
  await mkdir(join(root, 'docs/evidence'), { recursive: true })
  await writeFile(join(root, 'docs/evidence/server-package.json'), JSON.stringify({ testedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: process.version,
    checks: ['self-contained-package-links', 'no-react-or-node-pty-runtime-dependency', 'license-and-third-party-notices-in-package', 'bundled-cli-password-initialization', 'bundled-server-http-start', 'authenticated-story-settings-skills', 'background-upload-sanitization-selection-and-thumbnails', 'bundled-background-presets-and-selection', 'live-cli-password-revokes-cookie', 'graceful-shutdown', 'no-password-in-logs'],
    limitation: 'Backend package only. This proof does not cover WebUI, Compose, Linux app image or a live model provider.',
  }, null, 2) + '\n')
  console.log('通过：独立包启动、管理员初始化、故事/设置/Skills、背景上传与应用、在线重置撤销登录和正常关闭。')
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGKILL')
    await new Promise(resolve => server.once('exit', resolve))
  }
  await rm(directory, { recursive: true, force: true })
}
