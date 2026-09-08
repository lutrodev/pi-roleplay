import type { ModelRoute } from '../../../../packages/rp-core/src/types.ts'
import type { FrozenWriterHistory } from '../../../../packages/rp-core/src/agents/writer-history.ts'
import { RpError } from '../../../../packages/rp-core/src/errors.ts'
import type { StoryService } from '../services/story-service.ts'
import type { TurnService } from '../services/turn-service.ts'
import type { SkillService } from '../services/skill-service.ts'
import type { SubagentService } from '../services/subagent-service.ts'
import type { ExecutionResources } from './executor.ts'
import type { ModelRegistry } from './models.ts'
import type { SystemTools } from './system-tools.ts'
import { SkillSession } from './skills.ts'
import { RoleplayTools } from './roleplay-tools.ts'
import { TaskSession } from './tasks.ts'
import { disabledSkillNames } from '../../../../packages/rp-core/src/settings/skills.ts'
import { storyVariables } from '../../../../packages/rp-core/src/story/variables.ts'
import { storySubagentCatalog } from '../../../../packages/rp-core/src/agents/session-routes.ts'

export interface ResourceOptions { skills: boolean; disabledSkills: string[]; subagents: boolean; identity?: string; writerHistory?: FrozenWriterHistory }

/** Capture one coherent set of model routes, skill bodies and task definitions when a queued run starts. */
export class ResourceFactory {
  constructor(readonly stories: StoryService, readonly turns: TurnService, readonly system: SystemTools, readonly models: ModelRegistry,
    readonly skillService: SkillService, readonly subagents: SubagentService, readonly defaultMain: ModelRoute, readonly options: ResourceOptions) {}

  async prepare(runId: string, signal: AbortSignal): Promise<ExecutionResources> {
    signal.throwIfAborted()
    const writerHistory = this.options.writerHistory ? structuredClone(this.options.writerHistory) : undefined
    const run = this.stories.repository.run(runId), story = this.stories.repository.snapshot(run.storyId)
    const agent = story.profile.runtime.executionMode === 'agent', attachments = this.system.files.attachmentsForRun(runId)
    const catalog = storySubagentCatalog(this.subagents.snapshot(), story.profile.runtime)
    const routes = this.models.routes(story.profile, { main: this.defaultMain, ...(catalog.writer.route.kind === 'fixed' ? { writer: catalog.writer.route } : {}) })
    const main = this.models.resolve(routes.main, attachments.images), writer = this.models.resolve(routes.writer, attachments.images)
    const { enabled: stateEnabled } = storyVariables(story.profile)
    const disabledSkills = disabledSkillNames(this.options.disabledSkills, stateEnabled)
    const snapshot = agent && this.options.skills ? await this.skillService.snapshot(disabledSkills) : undefined
    signal.throwIfAborted()
    const skills = snapshot ? new SkillSession(snapshot, story.messages.filter(message => message.runId === runId && message.role === 'user').map(message => message.text)) : undefined
    const rp = new RoleplayTools(this.stories, this.turns, this.system.files, this.system.client, skills, stateEnabled)
    const tasks = agent && this.options.subagents && catalog.subagents.some(item => item.enabled) ? new TaskSession(catalog.subagents, this.models, this.system, routes.main, attachments, snapshot, this.options.identity) : undefined
    return { routes, ...attachments, writerHistory, toolSettings: structuredClone(this.system.settings), specialists: tasks?.catalog ?? [], get parentInstructions() { return skills?.parentInstructions }, contextPolicy: { identity: this.options.identity },
      validateInputFiles: files => { requireVision(files, main.model.input.includes('image') && writer.model.input.includes('image')) },
      refreshInputs: () => {
        const next = this.system.files.attachmentsForRun(runId)
        attachments.files.splice(0, attachments.files.length, ...next.files)
        attachments.images.splice(0, attachments.images.length, ...next.images)
        skills?.invokeUserTexts(this.stories.repository.snapshot(run.storyId).messages.filter(message => message.runId === runId && message.role === 'user').map(message => message.text))
      },
      readonlyTools: this.system.readonlyFiles(run, signal, writer.model.input.includes('image')),
      beforeWriter: () => rp.assertReady(), beforeCommit: () => rp.assertReady(),
      tools: scope => agent ? [...this.system.agent(scope, main.model.input.includes('image')), ...rp.agent(scope), ...(skills ? [skills.tool()] : []), ...(tasks ? [tasks.tool(scope)] : [])]
        : [...this.system.readonlyFiles(run, signal, main.model.input.includes('image')), ...rp.read(run)],
    }
  }
}

function requireVision(files: import('../../../../packages/rp-core/src/types.ts').FileRecord[], supported: boolean) {
  if (!supported && files.some(file => file.mimeType.startsWith('image/'))) throw new RpError('MODEL_VISION_REQUIRED', '本轮主模型与 Writer 都需要支持图片才能接收图片干预；可改为排队并选择支持图片的模型。')
}
