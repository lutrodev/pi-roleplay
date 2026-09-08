import { Type, type ImageContent } from '@earendil-works/pi-ai'
import { renderTaskSubagentPrompt, TASK_SUBAGENT_TOOL_DESCRIPTION } from '../../../../packages/rp-core/src/context/prompts.js'
import { composeSystemPrompt } from '../../../../packages/rp-core/src/context/system-prompt.ts'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { resolveModelSelection, type TaskSubagent } from '../../../../packages/rp-core/src/agents/catalog.ts'
import type { FileRecord, JsonObject, ModelRoute } from '../../../../packages/rp-core/src/types.ts'
import type { SkillSnapshot } from '../services/skill-service.ts'
import type { RuntimeToolScope } from './executor.ts'
import type { ModelRegistry } from './models.ts'
import type { SystemTools } from './system-tools.ts'
import { RunJournal } from './journal.ts'
import { journalStream } from './model-journal.ts'
import { runIsolated } from './isolated.ts'
import { SkillSession } from './skills.ts'
import { defineTool, toolResult } from './tool-result.ts'

/** Editable usage contracts guide the parent. No name-based pipeline or parent transcript is injected into a child. */
export class TaskSession {
  private readonly definitions: TaskSubagent[]
  readonly catalog: JsonObject[]
  constructor(definitions: TaskSubagent[], readonly models: ModelRegistry, readonly system: SystemTools, readonly mainRoute: ModelRoute,
    readonly attachments: { files: FileRecord[]; images: ImageContent[] }, readonly skills?: SkillSnapshot, readonly identity?: string) {
    this.definitions = structuredClone(definitions.filter(item => item.enabled))
    this.catalog = this.definitions.map(item => ({ id: item.id, label: item.name, usageContract: item.description, revision: item.revision,
      inputSchema: { type: 'object', additionalProperties: true }, tools: [...item.tools] }))
  }

  tool(scope: RuntimeToolScope) {
    const journal = new RunJournal(this.system.files.stories, this.system.files.files, scope.run)
    return defineTool({ name: 'rp_run_subagent', label: '调用任务子代理', description: TASK_SUBAGENT_TOOL_DESCRIPTION,
      parameters: Type.Object({ subagent: Type.String({ enum: this.definitions.map(item => item.id), description: 'Use the exact id from specialist_catalog. Display labels are not callable IDs.' }), task: Type.String({ minLength: 1, maxLength: 20000 }), input: Type.Record(Type.String(), Type.Unknown()),
      }, { additionalProperties: false }),
      execute: async (callId, input, signal, update) => toolResult(async () => {
        const effectiveSignal = signal ? AbortSignal.any([scope.signal, signal]) : scope.signal
        effectiveSignal.throwIfAborted()
        const stories = this.system.files.stories
        requireValue(stories.run(scope.run.id).status === 'running' && stories.snapshot(scope.run.storyId).profile.runtime.executionMode === 'agent', 'SUBAGENT_NOT_AVAILABLE', '任务子代理只可在 Agent 模式的当前生成中调用。')
        const definition = this.definitions.find(item => item.id === input.subagent)
        requireValue(definition, 'SUBAGENT_NOT_AVAILABLE', '请使用本轮子代理目录中的 id，不能用显示名称代替。')
        const prompt = renderTaskSubagentPrompt({ task: input.task, input: input.input })
        requireValue([...prompt].length <= 20_000, 'SUBAGENT_INPUT_TOO_LARGE', '子代理任务和输入合计不能超过 20000 字，请整理后再调用。')
        const route = resolveModelSelection(definition.route, this.mainRoute)
        const { model } = this.models.resolve(route, this.attachments.images)
        const childScope = `task:${callId}`, parentCallId = journal.callId(callId)
        const tools = this.system.readonlyFiles(scope.run, effectiveSignal, model.input.includes('image'))
        const skills = definition.tools.includes('skill') && this.skills ? new SkillSession(this.skills) : undefined
        requireValue(!definition.tools.includes('skill') || skills, 'SKILL_UNAVAILABLE', '这个子代理要求 Skills，但本轮未启用。')
        if (skills) tools.push(skills.tool())
        if (definition.tools.includes('web_search')) tools.push(this.system.webSearch(scope.run, effectiveSignal, childScope))
        const systemPrompt = composeSystemPrompt({ role: 'task', identity: this.identity, model: route.model, taskInstructions: definition.instructions, skillInstructions: skills?.parentInstructions })
        const fileManifest = this.attachments.files.map(file => ({ id: file.id, name: file.name, mimeType: file.mimeType, path: `/inputs/${file.storageKey}` }))
        const userPrompt = prompt + (fileManifest.length ? '\n<current_attachments>\n' + JSON.stringify(fileManifest) + '\n</current_attachments>' : '')
        journal.model(parentCallId, 'task:request', { subagentId: definition.id, subagentName: definition.name, revision: definition.revision, route, systemPrompt, prompt: userPrompt, attachmentIds: this.attachments.files.map(file => file.id), tools: tools.map(tool => ({ name: tool.name, parameters: tool.parameters })) })
        let previousLength = 0
        const result = await runIsolated(this.models, { route, systemPrompt, prompt: userPrompt, images: this.attachments.images, tools, maxSteps: 12, signal: effectiveSignal,
          maxParallelToolCalls: this.system.settings.maxParallelToolCalls,
          streamFn: journalStream(journal, this.models, childScope, parentCallId),
          onText: text => { update?.({ content: [{ type: 'text', text }], details: { outputDelta: text.slice(previousLength) } }); previousLength = text.length },
          onMessage: message => journal.model(parentCallId, `task:${String(message.role)}`, message),
          onEvent: event => { if (event.type === 'message_start' && event.message.role === 'assistant') previousLength = 0; journal.tool(event, childScope, parentCallId) },
        })
        return { subagent: definition.id, revision: definition.revision, text: result.text }
      }),
    })
  }
}
