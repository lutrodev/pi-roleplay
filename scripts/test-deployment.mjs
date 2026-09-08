import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createListener } from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { historyConfig } from '../tests/writer-history-fixture.ts'

const root = fileURLToPath(new URL('../', import.meta.url)), directory = await realpath(await mkdtemp(join(tmpdir(), 'rp-deployment-')))
const targets = [], passed = [], evidence = {}, requests = []
let release, waiting = false
const narrative = '海风吹过码头，江栖将修好的船交还给林舟。'
const provider = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString()), names = body.tools?.map(tool => tool.function.name) ?? [], last = body.messages.at(-1)
  requests.push(body)
  assert.equal(request.headers.authorization, 'Bearer synthetic-deployment-key')
  let text = '', call
  if (names.includes('rp_write_turn')) {
    const currentInput = body.messages.findLastIndex(message => message.role === 'user')
    const performed = body.messages.slice(currentInput + 1).flatMap(message => (message.tool_calls ?? []).map(item => item.function.name))
    if (last?.role === 'user' && JSON.stringify(last.content).includes('DEPLOY_HOLD')) {
      waiting = true
      await new Promise(resolve => { release = resolve; response.once('close', resolve) })
      waiting = false
      if (response.destroyed) return
    }
    if (performed.includes('rp_write_turn')) call = { name: 'rp_commit_turn', args: { narrative, runSummary: '修好的船已经归还。', ...(!JSON.stringify(body.messages.filter(message => message.role === 'system')).includes('Reply options are disabled.') ? { extensions: { 'rp.reply-options': { options: ['沿海岸走向灯塔。', '留在码头检查旧船。'] } } } : {}) } }
    else if (performed.includes('bash')) call = { name: 'rp_write_turn', args: { action: 'write' } }
    else call = { name: 'bash', args: { command: 'printf "VPS 工作文件\\n" > vps.txt; id -u; test ! -e /data/app.sqlite && test ! -e /run/secrets/session_key && test ! -e /var/run/docker.sock && printf "private-files-absent\\n"; printf "%s\\n" "${RP_MODEL_API_KEY-unset}"; (printf bad > /inputs/forbidden) 2>/dev/null || printf "inputs-read-only\\n"; cat vps.txt' } }
  } else text = narrative
  const delta = { role: 'assistant', content: text, ...(call ? { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(`data: ${JSON.stringify({ id: randomUUID(), choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
})
await new Promise(resolve => provider.listen(0, '0.0.0.0', resolve))
const providerPort = provider.address().port

async function command(executable, args, { cwd = root, input, expectFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    process.stdout.on('data', bytes => { output = (output + bytes).slice(-262144) })
    process.stderr.on('data', bytes => { output = (output + bytes).slice(-262144) })
    const timer = setTimeout(() => { process.kill('SIGKILL'); reject(new Error('Deployment command timed out: ' + args.join(' '))) }, 150000)
    process.on('error', error => { clearTimeout(timer); reject(error) })
    process.on('exit', code => { clearTimeout(timer); (code === 0) !== expectFailure ? resolve(output.trim()) : reject(new Error(`Unexpected command exit ${code}: ${output}`)) })
    process.stdin.end(input)
  })
}
async function port() {
  const server = createListener(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value
}
async function until(check, label, seconds = 20) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(100) }
  throw new Error('Timed out: ' + label)
}
async function deployment(name) {
  const path = join(directory, name), http = await port(), https = await port(), application = await port()
  await mkdir(path)
  for (const item of ['deploy', 'scripts/deploy.py', 'scripts/deploy_config.py', 'skills/custom']) await cp(join(root, item), join(path, item), { recursive: true })
  const dc = (...args) => command('docker', ['compose', '--project-directory', path, '--env-file', join(path, '.env'), '-f', join(path, 'deploy/compose.yaml'), ...args])
  const run = (args, options = {}) => command('python3', ['scripts/deploy.py', ...args], { cwd: path, ...options })
  await run(['configure', `http://127.0.0.1:${http}`, '--project', 'rp-qa-' + name, '--caddy', '--port', String(application)])
  const original = await readFile(join(path, '.env'), 'utf8')
  await writeFile(join(path, '.env'), original.replace('RP_APP_IMAGE=pi-roleplay-app:0.1.0', `RP_APP_IMAGE=${process.env.RP_APP_TEST_IMAGE ?? 'pi-roleplay-app:0.1.0'}`).replace('RP_HTTPS_PORT=443', `RP_HTTPS_PORT=${https}`).replace('RP_TOOLS_IMAGE=pi-roleplay-tools:0.1.0', `RP_TOOLS_IMAGE=${process.env.RP_TOOLS_TEST_IMAGE ?? 'pi-roleplay-tools:dev'}`))
  const compose = await readFile(join(path, 'deploy/compose.yaml'), 'utf8')
  // Test-only host provider route and shorter health sampling; production service/mount/security layout is preserved.
  await writeFile(join(path, 'deploy/compose.yaml'), compose.replace('  app:\n', '  app:\n    extra_hosts: ["host.docker.internal:host-gateway"]\n').replaceAll('interval: 15s', 'interval: 1s'))
  await writeFile(join(path, 'config/models.json'), JSON.stringify({ models: [{ provider: 'fixture', model: 'gpt-6-astra', keyEnv: 'RP_MODEL_API_KEY', api: 'openai-completions', baseUrl: `http://host.docker.internal:${providerPort}/v1`, contextWindow: 128000, maxTokens: 8192 }], main: { provider: 'fixture', model: 'gpt-6-astra' } }))
  await writeFile(join(path, 'secrets/models.env'), 'RP_MODEL_API_KEY=synthetic-deployment-key\n')
  const target = { path, dc, run, origin: `http://127.0.0.1:${http}`, cookie: '' }
  targets.push(target)
  target.api = async (path, method = 'GET', body, status = 200) => {
    const form = body instanceof FormData
    const response = await fetch(target.origin + '/api' + path, { method, headers: { origin: target.origin, cookie: target.cookie, ...(body === undefined || form ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }) })
    const text = await response.text(); assert.equal(response.status, status, `${method} ${path}: ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  target.login = async () => {
    const response = await fetch(target.origin + '/api/auth/login', { method: 'POST', headers: { origin: target.origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-deployment-password' }) })
    assert.equal(response.status, 200); target.cookie = response.headers.get('set-cookie').split(';')[0]
  }
  return target
}

try {
  const source = await deployment(randomUUID().slice(0, 8))
  await source.run(['password', '--password-stdin'], { input: 'synthetic-deployment-password\n' })
  await source.run(['up']); await source.login()
  assert.match(await (await fetch(source.origin + '/library', { headers: { accept: 'text/html' } })).text(), /<div id="root">/)
  const containers = JSON.parse(await command('docker', ['inspect', ...(await source.dc('ps', '-q')).split('\n')]))
  assert.equal(containers.length, 3)
  const app = containers.find(value => value.Config.Labels['com.docker.compose.service'] === 'app')
  const tools = containers.find(value => value.Config.Labels['com.docker.compose.service'] === 'tools')
  for (const container of [app, tools]) {
    assert.equal(container.Config.User, '10001:10001'); assert.equal(container.HostConfig.ReadonlyRootfs, true)
    assert(container.HostConfig.CapDrop.includes('ALL'))
    assert.equal(container.HostConfig.PidsLimit, 128); assert(container.HostConfig.SecurityOpt.includes('no-new-privileges:true'))
  }
  assert.deepEqual(tools.HostConfig.PortBindings, {})
  assert.equal(Object.keys(app.HostConfig.PortBindings).length, 1)
  assert.equal(app.HostConfig.PortBindings['3091/tcp'][0].HostIp, '127.0.0.1')
  assert.deepEqual(tools.Mounts.filter(value => value.Type === 'bind').map(value => [value.Destination, value.RW]).sort(), [['/inputs', false], ['/run/secrets/tool_token', false], ['/skills/custom', false], ['/workspaces', true]])
  assert(!tools.Config.Env.some(value => value.startsWith('RP_MODEL_API_KEY=')))
  const imageInfo = JSON.parse(await command('docker', ['image', 'inspect', app.Image]))[0]
  evidence.platform = `${imageInfo.Os}/${imageInfo.Architecture}`
  evidence.containerArchitectures = Object.fromEntries(await Promise.all(containers.map(async value => [value.Config.Labels['com.docker.compose.service'], await command('docker', ['exec', value.Id, 'uname', '-m'])])))
  if (process.env.DOCKER_DEFAULT_PLATFORM === 'linux/amd64') assert(Object.values(evidence.containerArchitectures).every(value => value === 'x86_64'))
  evidence.images = Object.fromEntries(containers.map(value => [value.Config.Labels['com.docker.compose.service'], value.Image]))
  evidence.limits = { appMemory: app.HostConfig.Memory, toolsMemory: tools.HostConfig.Memory }
  passed.push('Three real containers, Caddy static/API proxy, login, health, non-root and mount/environment/resource boundaries')
  console.log('通过：三容器启动、Caddy 页面/API、鉴权和实际挂载边界。')

  const settings = await source.api('/settings')
  const savedPreferences = await source.api('/settings', 'PUT', { expectedRevision: settings.revision, preferences: { ...settings.preferences, quickRepliesEnabled: false, replyOptionsEnabled: false, subagentsEnabled: false, reading: { ...settings.preferences.reading, showAvatars: false, showStateCard: false, dialogueColor: 'purple', theme: 'dark' } } })
  const initialHistory = await source.api('/settings/writer-history')
  assert.equal(initialHistory.config.enabled, false)
  const savedHistory = await source.api('/settings/writer-history', 'PUT', { expectedRevision: initialHistory.revision, config: historyConfig() })
  const workspace = (await source.api('/workspaces', 'POST', { name: 'VPS 工作区', access: 'read-write' }, 201)).workspace
  assert.equal(workspace.directory, `workspace-${workspace.id}`)
  const story = (await source.api('/stories', 'POST', { title: 'VPS 原创验收', workspaceId: workspace.id, profile: { runtime: { executionMode: 'agent', reasoningEffort: 'high', writerRoute: { kind: 'inherit', reasoningEffort: 'low' } }, variables: { enabled: false, mvu: false } } }, 201)).story
  const upload = new FormData(); upload.append('file', new Blob(['附件原件：旧船已经修好。'], { type: 'text/plain' }), 'original.txt')
  const file = (await source.api('/files', 'POST', upload, 201)).file
  const sent = await source.api(`/stories/${story.id}/messages`, 'POST', { requestId: randomUUID(), inputs: [{ text: '归还旧船，写下工作记录。', attachmentIds: [file.id] }] }, 202)
  await until(async () => (await source.api(`/runs/${sent.run.id}`)).run.status === 'completed', 'Agent narrative commit')
  const snapshot = (await source.api(`/stories/${story.id}`)).story
  assert.equal(snapshot.messages.at(-1).text, narrative)
  const writerRequest = requests.find(request => JSON.stringify(request.messages).includes('900719925474099312345'))
  assert(writerRequest)
  assert.equal(writerRequest.reasoning_effort, 'low')
  assert(requests.filter(request => request.tools?.some(tool => tool.function.name === 'rp_write_turn')).every(request => request.reasoning_effort === 'high'))
  // The actual Pi adapter uses the developer role for this reasoning model's leading instruction.
  assert.equal(writerRequest.messages[0].role, 'developer')
  assert.deepEqual(writerRequest.messages.slice(1, 11).map(message => message.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant'])
  assert(!requests.filter(request => request.tools?.some(tool => tool.function.name === 'rp_write_turn')).some(request => JSON.stringify(request).includes('900719925474099312345')))
  const records = await source.api(`/runs/${sent.run.id}/tools`)
  assert.match(JSON.stringify(records), /10001.*private-files-absent.*unset.*inputs-read-only/s)
  assert(!JSON.stringify(records).includes('read_log'))
  passed.push('Writer-only native preset history: leading developer instruction for a reasoning model, paired serial calls, lossless numbers, no historical tool execution')
  assert.equal((await source.api(`/stories/${story.id}/files/preview?path=vps.txt`)).text, 'VPS 工作文件\n')
  const branch = (await source.api(`/stories/${story.id}/messages/${snapshot.messages.at(-1).id}/fork`, 'POST', { expectedRevision: snapshot.revision }, 201)).story
  assert.equal((await source.api(`/stories/${branch.id}/files/preview?path=vps.txt`)).text, 'VPS 工作文件\n')
  passed.push('Real Pi network protocol → Linux Bash → Writer → atomic narrative, attachment and work-file preview')

  const enabledSuggestions = await source.api('/settings', 'PUT', { expectedRevision: savedPreferences.revision, preferences: { ...savedPreferences.preferences, replyOptionsEnabled: true } })
  const suggestionStory = (await source.api('/stories', 'POST', { title: '回复建议原子提交恢复', profile: { runtime: { executionMode: 'agent' } } }, 201)).story
  const suggestionRun = await source.api(`/stories/${suggestionStory.id}/messages`, 'POST', { requestId: randomUUID(), inputs: [{ text: '修好船后继续旅程。', attachmentIds: [] }] }, 202)
  await until(async () => (await source.api(`/runs/${suggestionRun.run.id}`)).run.status === 'completed', 'Narrative with reply options')
  const suggestionSnapshot = (await source.api(`/stories/${suggestionStory.id}`)).story
  assert.equal(suggestionSnapshot.messages.at(-1).text, narrative)
  assert.deepEqual(suggestionSnapshot.replyOptions[suggestionSnapshot.messages.at(-1).id], ['沿海岸走向灯塔。', '留在码头检查旧船。'])
  assert.equal(requests.filter(request => request.tools?.some(tool => tool.function.name === 'emit_reply_options')).length, 0)
  await source.api('/settings', 'PUT', { expectedRevision: enabledSuggestions.revision, preferences: savedPreferences.preferences })

  const holding = (await source.api('/stories', 'POST', { title: '中断测试', profile: { runtime: { executionMode: 'agent' } } }, 201)).story
  const pending = await source.api(`/stories/${holding.id}/messages`, 'POST', { requestId: randomUUID(), inputs: [{ text: 'DEPLOY_HOLD', attachmentIds: [] }] }, 202)
  await until(() => waiting, 'provider waiting')
  assert.match(await source.run(['backup'], { expectFailure: true }), /仍有生成/)
  assert.equal((await source.api(`/runs/${pending.run.id}`)).run.status, 'running')
  await source.dc('kill', '-s', 'SIGKILL', 'app')
  const count = requests.length
  await source.run(['up']); await source.login()
  assert.equal((await source.api(`/runs/${pending.run.id}`)).run.status, 'interrupted')
  assert.equal(requests.length, count)
  passed.push('Busy backup refuses without stopping active work; abrupt app death marks run interrupted without replay')

  await source.api('/workspaces/' + workspace.id, 'PUT', { expectedRevision: workspace.revision, name: 'VPS 只读归档', access: 'read-only' })
  const sidebar = await source.api('/settings/sidebar')
  await source.api('/settings/sidebar', 'PUT', { expectedRevision: sidebar.revision, sort: 'manual', view: 'workspaces', order: [branch.id, story.id], workspaceOrder: [workspace.id], pinnedStoryIds: [story.id] })
  const toolsSettings = await source.api('/settings/tools')
  await source.api('/settings/tools', 'PUT', { expectedRevision: toolsSettings.revision, settings: { ...toolsSettings.settings, commandTimeoutMs: 45000, maxOutputBytes: 4096, maxParallelToolCalls: 2 }, apiKey: 'synthetic-backup-search-key' })
  const modelCatalog = await source.api('/settings/providers')
  const savedModels = await source.api('/settings/providers', 'POST', { expectedRevision: modelCatalog.revision, provider: {
    id: 'backup-model', label: 'Backup model connection', apiKey: 'synthetic-deployment-key', connection: { api: 'openai-completions', baseUrl: `http://host.docker.internal:${providerPort}/v1` },
    models: [{ model: 'rp', contextWindow: 128000, maxTokens: 8192, input: ['text'], temperature: 0.6, compat: { supportsStore: false } }],
  } }, 201)
  assert.equal((await source.api('/settings/providers/backup-model/test', 'POST', { expectedRevision: savedModels.revision, model: 'rp' })).status, 'passed')
  const requestCountAfterModelCheck = requests.length
  const deletedRequest = { requestId: randomUUID(), title: '删除恢复验收', workspaceId: workspace.id, profile: { scene: { openingSource: 'custom', openingText: '保留在独立分支中的原创开场。' } } }
  const deletedStory = (await source.api('/stories', 'POST', deletedRequest, 201)).story
  const retainedBranch = (await source.api(`/stories/${deletedStory.id}/messages/${deletedStory.messages[0].id}/fork`, 'POST', { expectedRevision: deletedStory.revision }, 201)).story
  const beforeDeleteSidebar = await source.api('/settings/sidebar')
  await source.api(`/settings/sidebar/pins/${deletedStory.id}`, 'PATCH', { expectedRevision: beforeDeleteSidebar.revision, pinned: true })
  await source.api(`/stories/${deletedStory.id}`, 'DELETE', { expectedRevision: deletedStory.revision }, 204)
  assert.equal((await source.api(`/stories/${deletedStory.id}`, 'GET', undefined, 404)).error.code, 'STORY_NOT_FOUND')
  assert.equal((await source.api(`/stories/${retainedBranch.id}`)).forkSourceAvailable, false)
  assert.equal((await source.api(`/stories/${retainedBranch.id}/files/preview?path=vps.txt`)).text, 'VPS 工作文件\n')
  assert.deepEqual((await source.api('/settings/sidebar')).pinnedStoryIds, [story.id])
  await source.run(['backup'])
  const archives = (await readdir(join(source.path, 'backups'))).filter(file => file.endsWith('.tar.gz'))
  assert.equal(archives.length, 1)
  const archive = join(source.path, 'backups', archives[0])
  assert.equal((await source.api('/system/status')).operations.backup.status, 'completed')
  assert.equal((await source.api('/system/status')).operations.quiesced, false)
  assert.equal((await source.api(`/stories/${story.id}/files/preview?path=vps.txt`)).text, 'VPS 工作文件\n')
  passed.push('Cold backup, SQLite integrity and hash manifest, successful restart and visible backup record')
  console.log('通过：真实 Agent/工具文件、忙时拒绝备份、崩溃不重放、冷备份与服务恢复。')

  const archiveManifest = JSON.parse(await readFile(archive + '.json', 'utf8'))
  // Seed prior history using byte-identical copies of the backup just verified, then perform another real cold backup.
  for (let index = 1; index <= 8; index++) {
    const name = `rp-2000-01-${String(index).padStart(2, '0')}T00-00-00-000000Z.tar.gz`, target = join(source.path, 'backups', name)
    await cp(archive, target); await writeFile(target + '.json', JSON.stringify({ ...archiveManifest, file: name }))
  }
  await writeFile(join(source.path, 'backups', 'operator-note.txt'), 'Keep this unrelated file.')
  await source.run(['backup'])
  const retained = await readdir(join(source.path, 'backups'))
  assert.equal(retained.filter(name => name.endsWith('.tar.gz')).length, 7)
  assert(retained.includes('operator-note.txt')); assert(!retained.some(name => name.startsWith('rp-2000-01-03')))
  passed.push('Seven-backup retention verified with prior archive copies plus a new cold backup; unrelated files preserved')
  const restored = await deployment(randomUUID().slice(0, 8))
  const corrupt = join(directory, 'corrupt.tar.gz')
  await writeFile(corrupt, 'invalid archive'); await writeFile(corrupt + '.json', JSON.stringify(archiveManifest))
  assert.match(await restored.run(['restore', corrupt], { expectFailure: true }), /SHA-256/)
  await restored.run(['restore', archive])
  assert.match(await restored.run(['restore', archive], { expectFailure: true }), /not empty/)
  // Web-saved credentials require the separately backed-up encryption root key.
  await rm(join(restored.path, 'secrets/session_key'))
  await cp(join(source.path, 'secrets/session_key'), join(restored.path, 'secrets/session_key'))
  await restored.run(['up']); await restored.login()
  const result = (await restored.api(`/stories/${story.id}`)).story
  const restoredSuggestions = (await restored.api(`/stories/${suggestionStory.id}`)).story
  assert.deepEqual(restoredSuggestions.messages, suggestionSnapshot.messages)
  assert.deepEqual(restoredSuggestions.replyOptions, suggestionSnapshot.replyOptions)
  passed.push('Reply suggestions saved with the narrative survive cold backup and restore without a new generation request')
  assert.deepEqual(result.messages, snapshot.messages)
  assert.deepEqual(result.profile.runtime, snapshot.profile.runtime)
  passed.push('Catalog-recognized reasoning reaches real container requests: main high, inherited Writer low; independent settings survive cold backup and restore')
  assert.deepEqual(result.profile.variables, { enabled: false, mvu: false })
  assert.equal((await restored.api(`/stories/${story.id}/files/preview?path=vps.txt`)).text, 'VPS 工作文件\n')
  assert.equal((await restored.api(`/stories/${branch.id}/files/preview?path=vps.txt`)).text, 'VPS 工作文件\n')
  assert.equal(await (await fetch(restored.origin + `/api/files/${file.id}/content`, { headers: { cookie: restored.cookie } })).text(), '附件原件：旧船已经修好。')
  assert.equal((await restored.api('/system/status')).operations.backup.status, 'restored')
  assert.equal((await restored.api('/workspaces')).workspaces.find(item => item.id === workspace.id).name, 'VPS 只读归档')
  const newSession = (await restored.api('/stories', 'POST', { title: '恢复后新建会话' }, 201)).story
  assert.equal((await restored.api(`/stories/${newSession.id}/workspace`)).binding.access, 'read-write')
  for (const id of [story.id, branch.id]) assert.deepEqual((await restored.api(`/stories/${id}/workspace`)).binding, { workspaceId: workspace.id, directory: workspace.directory, access: 'read-only', createIfMissing: false })
  assert.equal((await restored.api('/settings/sidebar')).view, 'workspaces')
  const restoredPreferences = await restored.api('/settings')
  assert.deepEqual(restoredPreferences.preferences, savedPreferences.preferences)
  assert.equal(restoredPreferences.version, savedPreferences.version)
  passed.push('Per-page enable switches, message display preferences, and per-story variables/MVU survive backup and restore')
  passed.push('Dialogue color, highlight switch and versioned reading preferences survive cold backup and restore')
  assert.deepEqual(await restored.api('/settings/writer-history'), savedHistory)
  passed.push('Writer preset history revision, enabled switch and lossless JSON survive cold backup and empty-directory restore')
  assert.deepEqual((await restored.api('/settings/sidebar')).pinnedStoryIds, [story.id])
  assert.equal((await restored.api(`/stories/${deletedStory.id}`, 'GET', undefined, 404)).error.code, 'STORY_NOT_FOUND')
  assert.equal((await restored.api('/stories', 'POST', deletedRequest, 409)).error.code, 'STORY_DELETED')
  assert.deepEqual((await restored.api(`/stories/${retainedBranch.id}`)).story.messages, retainedBranch.messages)
  assert.equal((await restored.api(`/stories/${retainedBranch.id}/files/preview?path=vps.txt`)).text, 'VPS 工作文件\n')
  passed.push('Permanent deletion and creation replay protection survive cold backup/restore; branch content, workspace files and unrelated pins are preserved')
  const restoredTools = await restored.api('/settings/tools')
  assert.equal(restoredTools.settings.commandTimeoutMs, 45000); assert.equal(restoredTools.settings.maxOutputBytes, 4096); assert.equal(restoredTools.settings.maxParallelToolCalls, 2)
  assert.equal(restoredTools.searchKey.configured, true); assert.equal(JSON.stringify(restoredTools).includes('synthetic-backup-search-key'), false)
  const restoredModels = await restored.api('/settings/providers'), restoredConnection = restoredModels.providers.find(provider => provider.id === 'backup-model')
  assert.equal(restoredConnection.keyStored, true); assert.equal(restoredConnection.credentialConfigured, true)
  assert.equal(restoredConnection.models[0].check.status, 'passed'); assert.equal(restoredConnection.models[0].temperature, 0.6)
  assert.equal(restoredConnection.models[0].compat.supportsStore, false); assert.equal(JSON.stringify(restoredModels).includes('synthetic-deployment-key'), false)
  passed.push('Model connection v2, encrypted model key, advanced overrides and configuration-bound test result survive cold backup and restore')
  passed.push('Named workspace membership, readonly/default permissions, grouping and encrypted tool configuration survive cold backup and empty-directory restore')
  const failed = await restored.api(`/runs/${pending.run.id}`)
  assert.equal(failed.run.status, 'interrupted')
  assert.equal(requests.length, requestCountAfterModelCheck)
  passed.push('Restore to a separate empty deployment with the original credential key and a new origin: password, full story, attachments and workspace byte identity; non-empty restore rejected')
  passed.push('Fork retains shared workspace files before and after cold backup and restore')
  console.log('通过：空目录、不同项目名恢复，正文/附件/工作文件一致，旧任务未重放。')
  evidence.stats = await source.dc('stats', '--no-stream', '--format', 'json')
  const logs = await source.dc('logs', '--no-color')
  assert(!logs.includes('synthetic-deployment-key') && !logs.includes('synthetic-deployment-password'))
  passed.push('Application and proxy logs contain no synthetic model key or admin password')
  await mkdir(join(root, 'docs/evidence'), { recursive: true })
  await writeFile(join(root, `docs/evidence/deployment-${imageInfo.Architecture}.json`), JSON.stringify({ testedAt: new Date().toISOString(), host: `${process.platform}/${process.arch}`, ...evidence, passed,
    limits: { ...evidence.limits, note: 'Docker Desktop Linux containers. No public DNS/ACME or real paid model API was used; this is not a 4GB VPS capacity benchmark.' },
    testOverrides: ['Loopback ephemeral Caddy ports and HTTP', 'Synthetic host provider DNS mapping', 'Health sampling 1s instead of production 15s'],
  }, null, 2) + '\n')
} catch (error) {
  for (const target of targets) console.error(await target.dc('logs', '--tail', '15', '--no-color').catch(() => 'logs unavailable'))
  throw error
} finally {
  release?.(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
  for (const target of targets.reverse()) await target.dc('down', '--volumes', '--remove-orphans').catch(error => console.error(error.message))
  if (process.env.RP_KEEP_DEPLOYMENT_FIXTURE === '1') console.log('Fixture retained: ' + directory)
  else await rm(directory, { recursive: true, force: true })
}
