import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// node-pty 1.1.0 ships its macOS prebuilt spawn-helper without execute bits.
// Apply the packaging repair during installation, never at runtime in a read-only container.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url)
  const directory = dirname(require.resolve('node-pty/package.json'))
  const helpers = ['build/Release', `prebuilds/darwin-${process.arch}`]
    .map(path => join(directory, path, 'spawn-helper')).filter(existsSync)
  if (!helpers.length) throw new Error('node-pty spawn-helper is missing; reinstall native dependencies.')
  for (const helper of helpers) {
    const mode = statSync(helper).mode & 0o777
    if (!(mode & 0o111)) chmodSync(helper, mode | 0o111)
  }
}
