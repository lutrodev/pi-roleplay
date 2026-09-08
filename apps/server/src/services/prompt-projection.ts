import { systemPromptSections, type PromptRole } from '../../../../packages/rp-core/src/context/system-prompt.ts'
import { disabledSkillNames } from '../../../../packages/rp-core/src/settings/skills.ts'
import type { Preferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import type { ModelRoute } from '../../../../packages/rp-core/src/types.ts'
import { SkillSession } from '../runtime/skills.ts'
import type { SkillService } from './skill-service.ts'
import type { SubagentService } from './subagent-service.ts'

export async function promptProjection(preferences: Preferences, skills: SkillService, subagents: SubagentService, defaultMain?: ModelRoute | null) {
  const catalog = subagents.snapshot(), main = preferences.mainModel ?? defaultMain
  const writer = catalog.writer.route.kind === 'fixed' ? catalog.writer.route : main
  const enabledSkills = preferences.skills ? await skills.snapshot(disabledSkillNames(preferences.disabledSkills)) : undefined
  const instructions = enabledSkills ? new SkillSession(enabledSkills).parentInstructions : undefined
  const common = { identity: preferences.identity, stateEnabled: true, replyOptions: preferences.replyOptionsEnabled ? preferences.replyOptions : undefined }
  const role = (id: string, label: string, role: PromptRole, model: ModelRoute | null | undefined, extra: { taskInstructions?: string; skillInstructions?: string } = {}) => ({
    id, label, role, model: model ?? null,
    sections: systemPromptSections({ ...common, role, model: model?.model, ...extra }),
  })
  return { roles: [
    role('chat', 'Chat', 'chat', main), role('agent', 'Agent', 'agent', main, { skillInstructions: instructions }),
    role('writer', 'Writer', 'writer', writer),
    ...catalog.subagents.map(task => ({ ...role(task.id, task.name, 'task', task.route.kind === 'fixed' ? task.route : main,
      { taskInstructions: task.instructions, skillInstructions: task.tools.includes('skill') ? instructions : undefined }), enabled: task.enabled && preferences.subagentsEnabled, optionalTools: task.tools })),
  ], diagnostics: enabledSkills?.diagnostics ?? [] }
}
