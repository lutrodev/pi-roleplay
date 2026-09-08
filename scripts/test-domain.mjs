import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('../packages/rp-core/test/', import.meta.url))
async function testsIn(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await testsIn(path))
    else if (entry.name.endsWith('.test.js')) files.push(path)
  }
  return files.sort()
}
const files = await testsIn(root)
if (files.length === 0) throw new Error('No domain tests found')
const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit' })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
