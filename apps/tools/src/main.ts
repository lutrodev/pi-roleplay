import { readFile, stat } from 'node:fs/promises'
import { createToolServer } from './server.ts'

// The exported factory is exercised with temporary fixtures in tests; this executable is container-only.
if (process.platform !== 'linux' || process.getuid?.() === 0 || !await stat('/.dockerenv').then(() => true, () => false)) {
  throw new Error('Start the tools service in its non-root Docker container. Host execution is not supported.')
}
const token = (await readFile('/run/secrets/tool_token', 'utf8')).trim()
const { app } = createToolServer({ token, logger: true, roots: { workspaces: '/workspaces', inputs: '/inputs', skills: '/skills' } })
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close().catch(error => { app.log.error(error); process.exitCode = 1 }) })
await app.listen({ host: '0.0.0.0', port: 3092 })
