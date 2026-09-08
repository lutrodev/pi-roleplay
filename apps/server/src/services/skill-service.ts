import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parseDocument } from 'yaml'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'

export interface SkillDefinition {
  name: string
  description: string
  content: string
  resourceBase: { kind: 'directory'; path: string }
  sha256: string
  modelInvocable: boolean
  userInvocable: boolean
}
export interface SkillSnapshot { skills: SkillDefinition[]; diagnostics: { path: string; message: string }[] }
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Only configured, read-only roots are scanned. Invalid or duplicate definitions remain visible as diagnostics. */
export class SkillService {
  constructor(readonly roots: { path: string; virtualPath: string }[]) {}

  async snapshot(disabled: string[] = []): Promise<SkillSnapshot> {
    const skills = new Map<string, SkillDefinition>(), duplicates = new Set<string>()
    const diagnostics: SkillSnapshot['diagnostics'] = []
    let examined = 0, directories = 0
    for (const root of this.roots) {
      let canonical: string
      try { canonical = await realpath(root.path) }
      catch { diagnostics.push({ path: root.virtualPath, message: 'Skills 目录不存在或无法读取。' }); continue }
      const scan = async (directory: string, depth: number): Promise<void> => {
        const display = root.virtualPath + (relative(canonical, directory) ? '/' + relative(canonical, directory).split(sep).join('/') : '')
        try {
          requireValue(++directories <= 512, 'SKILL_LIMIT', 'Skills 目录扫描达到 512 个目录的上限。')
          const entries = await readdir(directory, { withFileTypes: true })
          const entry = entries.find(item => item.name === 'SKILL.md')
          if (entry) {
            requireValue(++examined <= 128, 'SKILL_LIMIT', '最多发现 128 份 Skill 定义。')
            requireValue(entry.isFile(), 'SKILL_INVALID', 'SKILL.md 必须为普通文件，不能使用符号链接。')
            const handle = await open(join(directory, 'SKILL.md'), constants.O_RDONLY | constants.O_NOFOLLOW)
            let bytes: Buffer
            try {
              const info = await handle.stat()
              requireValue(info.isFile() && info.size <= 65536, 'SKILL_TOO_LARGE', 'SKILL.md 不能超过 64 KB。')
              bytes = Buffer.alloc(65537)
              const result = await handle.read(bytes)
              requireValue(result.bytesRead <= 65536, 'SKILL_TOO_LARGE', 'SKILL.md 不能超过 64 KB。')
              bytes = bytes.subarray(0, result.bytesRead)
            } finally { await handle.close() }
            const skill = parseSkill(new TextDecoder('utf-8', { fatal: true }).decode(bytes), display)
            if (skills.has(skill.name) || duplicates.has(skill.name)) {
              duplicates.add(skill.name); skills.delete(skill.name)
              diagnostics.push({ path: display + '/SKILL.md', message: `Skill 名称 ${skill.name} 重复，已暂停加载这些同名定义。` })
            } else if (!disabled.includes(skill.name)) skills.set(skill.name, skill)
            return
          }
          for (const child of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (directories > 512 || examined > 128) break
            if (child.name.startsWith('.')) continue
            if (child.isSymbolicLink()) { diagnostics.push({ path: display + '/' + child.name, message: '未扫描符号链接。' }); continue }
            if (child.isDirectory() && depth < 4) await scan(join(directory, child.name), depth + 1)
          }
        } catch (error) {
          diagnostics.push({ path: display, message: error instanceof RpError ? error.message : 'Skill 文件无法读取，或不是有效的 UTF-8/YAML 内容。' })
        }
      }
      await scan(canonical, 0)
    }
    return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics }
  }
}

function parseSkill(text: string, path: string): SkillDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text)
  requireValue(match, 'SKILL_INVALID', 'Skill 需要 YAML 元数据区和正文。')
  const document = parseDocument(match[1]!, { uniqueKeys: true, schema: 'core' })
  requireValue(document.errors.length === 0 && document.warnings.length === 0, 'SKILL_INVALID', 'Skill 的 YAML 元数据不正确。')
  const data = document.toJS({ maxAliasCount: 20 }) as Record<string, unknown>
  requireValue(data && typeof data === 'object' && !Array.isArray(data), 'SKILL_INVALID', 'Skill 元数据必须是对象。')
  requireValue(typeof data.name === 'string' && data.name.length <= 64 && NAME.test(data.name), 'SKILL_INVALID', 'Skill 名称需要小写字母、数字或单个连字符。')
  requireValue(typeof data.description === 'string' && data.description.trim().length > 0 && data.description.length <= 2048, 'SKILL_INVALID', 'Skill 描述不能为空，且最多 2048 个字符。')
  for (const key of ['disable-model-invocation', 'user-invocable']) requireValue(data[key] === undefined || typeof data[key] === 'boolean', 'SKILL_INVALID', `Skill 的 ${key} 必须为布尔值。`)
  const content = match[2]!.trim()
  requireValue(content.length > 0, 'SKILL_INVALID', 'Skill 正文不能为空。')
  return { name: data.name, description: data.description.trim(), content, resourceBase: { kind: 'directory', path },
    sha256: createHash('sha256').update(text).digest('hex'), modelInvocable: data['disable-model-invocation'] !== true, userInvocable: data['user-invocable'] !== false }
}
