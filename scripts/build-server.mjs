import { build } from 'esbuild'
import { cp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
await build({ absWorkingDir: root, entryPoints: ['apps/server/src/main.ts', 'apps/server/src/cli.ts', 'apps/server/src/ops.ts'], outdir: 'apps/server/dist',
  bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', sourcemap: true,
})
await cp(new URL('../apps/server/src/backgrounds/', import.meta.url), new URL('../apps/server/dist/backgrounds/', import.meta.url), { recursive: true })
await Promise.all(['LICENSE', 'THIRD_PARTY_NOTICES.md'].map(name =>
  cp(new URL(`../${name}`, import.meta.url), new URL(`../apps/server/dist/${name}`, import.meta.url))))
