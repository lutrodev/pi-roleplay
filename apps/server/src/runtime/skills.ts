import { Type } from '@earendil-works/pi-ai'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { SkillDefinition, SkillSnapshot } from '../services/skill-service.ts'
import { defineTool, toolResult } from './tool-result.ts'

/** A session is scoped to one main or isolated Agent; another Agent loading a guide does not satisfy its prerequisites. */
export class SkillSession {
  private readonly skills: Map<string, SkillDefinition>
  private readonly loaded = new Set<string>()
  private readonly invoked = new Map<string, SkillDefinition>()

  constructor(snapshot: SkillSnapshot, directUserTexts: string[] = []) {
    this.skills = new Map(snapshot.skills.map(skill => [skill.name, structuredClone(skill)]))
    this.invokeUserTexts(directUserTexts)
  }
  invokeUserTexts(directUserTexts: string[]) {
    for (const text of directUserTexts) for (const match of text.matchAll(/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g)) {
      const skill = this.skills.get(match[2]!)
      if (skill?.userInvocable) { this.loaded.add(skill.name); this.invoked.set(skill.name, skill) }
    }
  }
  get parentInstructions() {
    const available = [...this.skills.values()].filter(skill => skill.modelInvocable)
    return [
      'Skills are reusable task instructions. Load an applicable skill before acting; descriptions alone are not the full instructions. A skill does not grant tools or authorize persistent changes. Resolve supporting files relative to its resourceBase using the read-only file tools; execute scripts only with Bash in the tools container.',
      '<available_skills>', ...available.map(skill => JSON.stringify({ name: skill.name, description: skill.description, sha256: skill.sha256 })), '</available_skills>',
      ...[...this.invoked.values()].map(skill => '<user_invoked_skill>\n' + JSON.stringify(skill) + '\n</user_invoked_skill>'),
    ].join('\n')
  }

  require(name: string) { requireValue(this.loaded.has(name), 'SKILL_REQUIRED', `请先加载 ${name}，再执行这类资料或变量操作。`) }
  tool() {
    return defineTool({ name: 'skill', label: '加载 Skill', description: 'Load the complete instructions of an available skill by exact name. The result includes a resourceBase for supporting files and scripts. Loading a skill does not itself authorize changes.',
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
      execute: async (_callId, input, signal) => toolResult(async () => {
        signal?.throwIfAborted()
        const skill = this.skills.get(input.name)
        requireValue(skill?.modelInvocable, 'SKILL_NOT_AVAILABLE', '这个 Skill 不可由模型加载；请查看当前目录或由用户直接调用。')
        this.loaded.add(skill.name)
        return JSON.parse(JSON.stringify(skill))
      }),
    })
  }
}
