import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
for (const args of [['build:server'], ['build:tools'], ['exec', 'vite', 'build']]) {
  const result = spawnSync('pnpm', args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
