import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('loads every browser route without relying on tree shaking to remove Node-only imports', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: ['apps/web/src/main.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    treeShaking: false,
    write: false,
    metafile: true,
    loader: { '.css': 'empty', '.svg': 'dataurl' },
    logLevel: 'silent',
  })
  // The lazy routes must all be included so this also guards pages not visited at startup.
  expect(Object.keys(result.metafile.inputs)).toEqual(expect.arrayContaining([
    'apps/web/src/pages/settings.tsx',
    'apps/web/src/pages/new-conversation.tsx',
    'apps/web/src/pages/library.tsx',
    'apps/web/src/pages/story/index.tsx',
  ]))
})
