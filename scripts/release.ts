import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditSource, digest, sourceArchive } from './release-support.ts'

async function main() {
  const command = process.argv[2]
  if (command === '--help' || command === '-h') { console.log('用法：pnpm release:check | pnpm release:pack\n检查公开源码、Git 暂存区和历史；pack 仅打包通过检查的白名单文件。报告不输出敏感值。'); return }
  if (!['check', 'pack'].includes(command ?? '') || process.argv.length !== 3) throw new Error('请使用 pnpm release:check 或 pnpm release:pack。')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const result = await auditSource(root)
  console.log(`公开候选 ${result.files.length} 个文件；排除 ${result.excluded.length} 个本地文件/目录。Git：${result.git === 'absent' ? '无独立仓库，无法检查历史' : result.git}。`)
  if (result.findings.length) {
    for (const finding of result.findings) console.error(`${finding.path}${finding.line ? ':' + finding.line : ''} — ${finding.rule}`)
    throw new Error(`发现 ${result.findings.length} 项需要处理；未生成源码包。报告未输出任何匹配的秘密值。`)
  }
  console.log('源码检查通过。扫描规则不能证明不存在所有敏感信息；公开范围与素材来源见 docs/open-source.md。')
  if (command === 'pack') {
    const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }
    if (!/^[\w.-]+$/.test(version)) throw new Error('版本号不能用作文件名。')
    const directory = join(root, 'output/releases'), name = `pi-roleplay-${version}-source.tar.gz`, archive = sourceArchive(result.files)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, name), archive, { mode: 0o600 })
    await writeFile(join(directory, name + '.sha256'), digest(archive) + '  ' + name + '\n', { mode: 0o600 })
    console.log(`已生成 output/releases/${name} 及 SHA-256 清单。包内不含 Git 历史、运行数据或本机文件元数据。`)
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '公开源码检查失败。'); process.exitCode = 1 })
