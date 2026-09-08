import { build } from 'esbuild'
import { cp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
await build({ absWorkingDir: root, entryPoints: ['apps/tools/src/main.ts'], outfile: 'apps/tools/dist/main.js',
  bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', sourcemap: true,
})
await Promise.all(['LICENSE', 'THIRD_PARTY_NOTICES.md'].map(name =>
  cp(new URL(`../${name}`, import.meta.url), new URL(`../apps/tools/dist/${name}`, import.meta.url))))
