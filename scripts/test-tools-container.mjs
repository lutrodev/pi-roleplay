import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile), image = process.env.RP_TOOLS_TEST_IMAGE ?? 'pi-roleplay-tools:dev'
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 2 * 1024 * 1024 })).stdout.trim()
const name = 'pi-roleplay-tools-test-' + randomUUID().slice(0, 8)
const directory = await realpath(await mkdtemp(join(tmpdir(), 'pi-roleplay-container-')))
const token = 'synthetic-container-test-' + randomUUID(), storyId = randomUUID(), passed = []
let baseUrl = ''
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
async function request(command, workspace = { directory: storyId, access: 'read-write', createIfMissing: true }) {
  const response = await fetch(baseUrl + '/v1/execute', { method: 'POST', headers, body: JSON.stringify({ id: randomUUID(), storyId, workspace, command }), signal: AbortSignal.timeout(10_000) })
  if (response.status !== 200) { const payload = await response.json(); throw Object.assign(new Error(payload.error?.message ?? 'Tool HTTP failure'), payload.error) }
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
  const result = events.at(-1)
  if (result.type === 'error') throw Object.assign(new Error(result.message), result)
  assert.equal(result.type, 'result')
  return result.value
}
try {
  for (const folder of ['workspaces', 'inputs', 'skills', 'private']) await mkdir(join(directory, folder))
  // Writable permissions deliberately prove the read-only mounts, independent of ordinary Unix mode checks.
  for (const folder of ['workspaces', 'inputs', 'skills']) await chmod(join(directory, folder), 0o777)
  await writeFile(join(directory, 'inputs', 'attachment.txt'), '只读附件', { mode: 0o666 })
  await writeFile(join(directory, 'skills', 'guide.md'), '只读技能', { mode: 0o666 })
  await writeFile(join(directory, 'private', 'app.sqlite'), 'synthetic-unmounted-database')
  await writeFile(join(directory, 'private', 'model-key'), 'synthetic-unmounted-model-key')
  await writeFile(join(directory, 'tool-token'), token, { mode: 0o444 })
  await docker('run', '-d', '--name', name, '--read-only', '--memory', '512m', '--cpus', '1', '--pids-limit', '128', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,nosuid,noexec,size=128m', '-p', '127.0.0.1::3092',
    '--mount', `type=bind,source=${join(directory, 'workspaces')},target=/workspaces`,
    '--mount', `type=bind,source=${join(directory, 'inputs')},target=/inputs,readonly`,
    '--mount', `type=bind,source=${join(directory, 'skills')},target=/skills/custom,readonly`,
    '--mount', `type=bind,source=${join(directory, 'tool-token')},target=/run/secrets/tool_token,readonly`, image)
  const container = JSON.parse(await docker('inspect', name))[0]
  const port = container.NetworkSettings.Ports['3092/tcp'][0].HostPort
  baseUrl = 'http://127.0.0.1:' + port
  let healthy = false
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { healthy = (await fetch(baseUrl + '/health', { headers, signal: AbortSignal.timeout(1000) })).ok } catch { /* Startup may still be binding. */ }
    if (healthy) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(healthy, 'Tools container did not become healthy')
  assert.equal((await fetch(baseUrl + '/health')).status, 401)
  passed.push('Container startup, health and token authentication')

  await request({ kind: 'edit', command: 'write', path: 'full-write.txt', fileText: '原稿' })
  await request({ kind: 'edit', command: 'write', path: 'full-write.txt', fileText: '海海' })
  await assert.rejects(request({ kind: 'edit', command: 'str_replace', path: 'full-write.txt', oldText: '海', newText: '塔' }), { code: 'EDIT_MATCH_CONFLICT' })
  await request({ kind: 'edit', command: 'str_replace', path: 'full-write.txt', oldText: '海', newText: '塔', replaceAll: true })
  assert.equal((await request({ kind: 'read', path: 'full-write.txt' })).text, '塔塔')
  await request({ kind: 'edit', command: 'undo_edit', path: 'full-write.txt' })
  assert.equal((await request({ kind: 'read', path: 'full-write.txt' })).text, '海海')
  await assert.rejects(request({ kind: 'edit', command: 'write', path: '/inputs/attachment.txt', fileText: 'bad' }), { code: 'READ_ONLY_PATH' })
  passed.push('Full file creation/overwrite, replace-all, conflict, undo and read-only mount guards')

  assert.equal(container.Config.User, '10001:10001')
  assert.equal(container.HostConfig.ReadonlyRootfs, true)
  assert.equal(container.HostConfig.Memory, 512 * 1024 * 1024)
  assert.equal(container.HostConfig.PidsLimit, 128)
  assert.ok(container.HostConfig.CapDrop.includes('ALL'))
  assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges'))
  assert.deepEqual(container.Mounts.filter(mount => mount.Type === 'bind').map(mount => [mount.Destination, mount.RW]).sort(),
    [['/inputs', false], ['/run/secrets/tool_token', false], ['/skills/custom', false], ['/workspaces', true]].sort())
  passed.push('Non-root user, read-only root, limited CPU/memory/PIDs and explicit mount set')

  const boundary = await request({ kind: 'bash', command: 'id -u; test ! -e /var/run/docker.sock && test ! -e /data/app.sqlite && test ! -e /run/secrets/model_keys && printf "private-files-absent\\n"; (printf bad > /inputs/new) 2>/dev/null || printf "inputs-read-only\\n"; (printf bad > /skills/new) 2>/dev/null || printf "skills-read-only\\n"; (printf bad > /opt/rp-tools/new) 2>/dev/null || printf "root-read-only\\n"; printf "%s\\n" "${DEEPSEEK_API_KEY-unset}"; cat /sys/fs/cgroup/memory.max; cat /sys/fs/cgroup/pids.max' })
  assert.equal(boundary.exitCode, 0)
  assert.match(boundary.output, /10001\nprivate-files-absent\ninputs-read-only\nskills-read-only\nroot-read-only\nunset\n536870912\n128/)
  passed.push('Bash cannot modify attachment/skill/root mounts or access application database, model-key environment and Docker socket')

  const persisted = await request({ kind: 'bash', command: 'mkdir nested; cd nested; export RP_CONTAINER_STATE=retained; printf "容器工作文件" > story.txt' })
  assert.equal(persisted.exitCode, 0)
  const next = await request({ kind: 'bash', command: 'printf "%s\\n" "$RP_CONTAINER_STATE"; pwd' })
  assert.match(next.output, new RegExp(`retained\\n/workspaces/${storyId}/nested`))
  assert.equal((await request({ kind: 'read', path: 'nested/story.txt' })).text, '容器工作文件')
  await request({ kind: 'edit', command: 'str_replace', path: 'nested/story.txt', oldText: '容器', newText: 'Linux' })
  assert.equal((await request({ kind: 'read', path: 'nested/story.txt' })).text, 'Linux工作文件')
  await request({ kind: 'edit', command: 'undo_edit', path: 'nested/story.txt' })
  assert.equal((await request({ kind: 'read', path: 'nested/story.txt' })).text, '容器工作文件')
  assert.equal((await request({ kind: 'read', path: '/inputs/attachment.txt' })).text, '只读附件')
  assert.equal((await request({ kind: 'read', path: '/skills/custom/guide.md' })).text, '只读技能')
  assert.match((await request({ kind: 'read', path: '/skills/builtin/rp-guide-state/SKILL.md' })).text, /name: rp-guide-state/)
  assert.match((await request({ kind: 'read', path: '/skills/builtin/rp-guide-state/references/protocol.md' })).text, /Restricted schema/)
  const download = await request({ kind: 'download', path: 'nested/story.txt' })
  assert.equal(Buffer.from(download.base64, 'base64').toString('utf8'), '容器工作文件')
  passed.push('Real Linux persistent Bash, shared work files, read-only inputs, file preview and byte-identical download')

  await assert.rejects(request({ kind: 'bash', command: 'sleep 30 & child=$!; printf "%s" "$child" > child.pid; wait "$child"', timeoutMs: 120 }), error => error.code === 'TOOL_TIMEOUT')
  const reset = await request({ kind: 'bash', command: 'printf "%s\\n" "${RP_CONTAINER_STATE-reset}"; pid=$(cat nested/child.pid); if kill -0 "$pid" 2>/dev/null; then ps -o stat= -p "$pid"; else printf "child-stopped\\n"; fi' })
  assert.equal(reset.shellState, 'new')
  assert.match(reset.output, /^reset\n(?:child-stopped|Z)/)
  passed.push('Timeout kills the ordinary child process group and the following command uses a fresh shell')

  const limited = await request({ kind: 'bash', command: 'printf "%0200d" 0', maxOutputBytes: 32 })
  assert.equal(limited.output.length, 32); assert.equal(limited.outputBytes, 200); assert.equal(limited.truncated, true)
  assert.equal((await request({ kind: 'read', path: limited.outputFile })).text, '0'.repeat(200))
  passed.push('Configured UTF-8 output cap preserves the complete output file at the workspace root')
  assert.equal((await fetch(baseUrl + '/v1/workspaces/prepare', { method: 'POST', headers, body: JSON.stringify({ directory: 'named-workspace' }) })).status, 200)
  const shared = { directory: 'named-workspace', access: 'read-write', createIfMissing: false }
  await request({ kind: 'edit', command: 'write', path: 'retained.txt', fileText: '只读保留文件' }, shared)
  const readonly = { ...shared, access: 'read-only' }
  assert.equal((await request({ kind: 'read', path: 'retained.txt' }, readonly)).text, '只读保留文件')
  await assert.rejects(request({ kind: 'bash', command: 'rm retained.txt' }, readonly), { code: 'WORKSPACE_READ_ONLY' })
  await assert.rejects(request({ kind: 'edit', command: 'write', path: 'retained.txt', fileText: 'wrong' }, readonly), { code: 'WORKSPACE_READ_ONLY' })
  passed.push('Named container directory creation and readonly enforcement in the tools HTTP service')

  await docker('stop', '--time', '5', name)
  await docker('start', name)
  // Docker may allocate a different ephemeral host port when restarting the container.
  const restarted = JSON.parse(await docker('inspect', name))[0]
  baseUrl = 'http://127.0.0.1:' + restarted.NetworkSettings.Ports['3092/tcp'][0].HostPort
  healthy = false
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { healthy = (await fetch(baseUrl + '/health', { headers, signal: AbortSignal.timeout(1000) })).ok } catch { /* Restart in progress. */ }
    if (healthy) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(healthy, 'Tools container did not recover after restart')
  assert.equal((await request({ kind: 'read', path: 'nested/story.txt' })).text, '容器工作文件')
  assert.equal((await request({ kind: 'read', path: 'retained.txt' }, readonly)).text, '只读保留文件')
  assert.equal(await readFile(join(directory, 'private', 'model-key'), 'utf8'), 'synthetic-unmounted-model-key')
  passed.push('Container restart preserves workspace files and does not modify unmounted private fixtures')
  const imageDetails = JSON.parse(await docker('image', 'inspect', image))[0]
  const evidence = { testedAt: new Date().toISOString(), image: imageDetails.Id, platform: `${imageDetails.Os}/${imageDetails.Architecture}`, passed }
  const output = fileURLToPath(new URL('../docs/evidence/', import.meta.url))
  await mkdir(output, { recursive: true })
  await writeFile(join(output, `tools-container-${imageDetails.Architecture}.json`), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  console.error(await docker('logs', '--tail', '30', name).catch(() => 'Container logs unavailable'))
  throw error
} finally {
  await docker('rm', '-f', name).catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
}
