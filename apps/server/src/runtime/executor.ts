import { storyVariables } from '../../../../packages/rp-core/src/story/variables.ts'
import { randomUUID } from 'node:crypto'
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import { Type, isContextOverflow, type ImageContent } from '@earendil-works/pi-ai'
import { AGENT_WRITER_TOOL_DESCRIPTION, CHAT_WRITER_TOOL_DESCRIPTION, COMMIT_TOOL_DESCRIPTION, renderWriterPrompt } from '../../../../packages/rp-core/src/context/prompts.js'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { createRoleplayMacroStream } from '../../../../packages/rp-core/src/macro/syntax.js'
import { objectInput } from '../../../../packages/rp-core/src/input.ts'
import { commitRetryParameterSchema } from '../../../../packages/rp-core/src/story/commit-retry.js'
import { stateUpdateEffectSchema } from '../../../../packages/rp-core/src/state/update.js'
import type { FileRecord, JsonObject, JsonValue, ModelRoute, RunRecord } from '../../../../packages/rp-core/src/types.ts'
import type { ContextService } from '../services/context-service.ts'
import type { TurnService } from '../services/turn-service.ts'
import type { StoryRepository } from '../storage/story-repository.ts'
import type { FileRepository } from '../storage/file-repository.ts'
import { runIsolated } from './isolated.ts'
import type { ModelRegistry } from './models.ts'
import { RunJournal } from './journal.ts'
import { journalStream } from './model-journal.ts'
import { toolResult } from './tool-result.ts'
import type { ContextPolicy } from '../../../../packages/rp-core/src/context/assemble.ts'
import { contextPruner } from './tool-pruner.ts'
import type { SummaryService } from '../services/summary-service.ts'
import type { InputQueueService } from '../services/input-queue-service.ts'
import type { Preferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import type { ToolSettings } from '../../../../packages/rp-core/src/settings/tools.ts'
import { boundedTools } from './tool-concurrency.ts'
import { writerHistoryPreview, type FrozenWriterHistory } from '../../../../packages/rp-core/src/agents/writer-history.ts'
import { ModelHistoryService } from '../services/model-history-service.ts'
import { parentMessages, type ParentMessage } from './parent-history.ts'

export interface RuntimeToolScope {
  run: RunRecord
  signal: AbortSignal
  owner: () => string
  writerText: () => string | null
  refreshContext: () => void
}
export interface ExecutionResources {
  replyOptions?: { config: Preferences['replyOptions']; enabled: () => boolean }
  writerHistory?: FrozenWriterHistory
  toolSettings?: ToolSettings
  routes: { main: ModelRoute; writer: ModelRoute }
  files: FileRecord[]
  images: ImageContent[]
  readonlyTools: AgentTool[]
  specialists: JsonObject[]
  parentInstructions?: string
  contextPolicy?: ContextPolicy
  tools: (scope: RuntimeToolScope) => AgentTool[]
  beforeWriter?: () => void
  beforeCommit?: () => void
  validateInputFiles?: (files: FileRecord[]) => void
  refreshInputs?: () => void
}

export class RunExecutor {
  constructor(readonly stories: StoryRepository, readonly contexts: ContextService, readonly turns: TurnService,
    readonly models: ModelRegistry, readonly files: FileRepository, readonly summaries?: SummaryService, readonly inputs?: InputQueueService) {}

  async execute(runId: string, signal: AbortSignal, resources: ExecutionResources) {
    signal.throwIfAborted()
    const run = this.stories.run(runId)
    const history = new ModelHistoryService(this.stories)
    history.restoreBranch(run.storyId)
    const writerHistory = resources.writerHistory ? structuredClone(resources.writerHistory) : undefined
    await this.summaries?.beforeRun(runId, signal)
    signal.throwIfAborted()
    const journal = new RunJournal(this.stories, this.files, run)
    if (writerHistory) journal.model('runtime', 'runtime:writer-history', JSON.parse(JSON.stringify(writerHistory)))
    if (resources.toolSettings) journal.model('runtime', 'runtime:tool-settings', JSON.parse(JSON.stringify(resources.toolSettings)))
    const parallel = resources.toolSettings?.maxParallelToolCalls ?? 1
    const story = this.stories.snapshot(run.storyId)
    const mode = story.profile.runtime.executionMode
    const routes = resources.routes
    const resolved = this.models.resolve(routes.main, resources.images)
    this.models.resolve(routes.writer, resources.images)
    requireValue(resources.files.every(file => file.mimeType.startsWith('image/')) || resources.readonlyTools.length > 0,
      'ATTACHMENT_TOOLS_UNAVAILABLE', '文件附件需要可用的只读文件工具。')
    const contextPolicy = { ...resources.contextPolicy, writerModel: routes.writer.model, replyOptions: resources.replyOptions?.config }
    let context = this.contexts.freeze(runId, routes.main, resources.files, resources.specialists, resources.parentInstructions, contextPolicy)
    const stateEnabled = storyVariables(story.profile).enabled
    let writerText: string | null = null
    let writerOwner = ''
    let currentOwner = ''
    let currentText = ''
    let committed = false
    let replied = false
    let terminalWriterError: RpError | undefined
    let steps = 0
    let lastPersistedAt = 0
    let recoveryNarrative: string | null = null
    let pendingRefresh = false
    let overflowAttempted = false
    let macro = createRoleplayMacroStream(context.identities)
    const omittedCalls = new Set<string>()
    const conversation = () => {
      const current = this.stories.snapshot(run.storyId)
      const native = parentMessages(history.read(current, runId), this.files, resolved.model)
      for (const item of native.omitted) if (!omittedCalls.has(item.id)) {
        omittedCalls.add(item.id)
        journal.model('history', 'history:incomplete-call', { ...item, reason: 'No durable tool result; historical call is not replayed.' })
      }
      if (mode === 'chat' && current.checkpoint) native.messages.unshift({ role: 'user',
        content: [{ type: 'text', text: `<conversation_summary>\n${current.checkpoint.text}\n</conversation_summary>` }], timestamp: 0,
        rpHistoryId: `summary:${current.checkpoint.throughMessageId}`, rpSource: 'runtime', rpRunId: null,
      } as ParentMessage)
      return native.messages
    }
    const maxSteps = story.profile.runtime.maxSteps ?? (mode === 'chat' ? 5 : 20)
    // Conversation drafts contain Writer prose or an explicit final narrative, never parent commentary.
    const persistDraft = (text: string, force = false) => {
      if (!force && Date.now() - lastPersistedAt < 150) return
      this.stories.saveDraft(runId, text)
      lastPersistedAt = Date.now()
    }
    const renderNarrative = (text: string, complete = true) => {
      requireValue([...text].length <= 200_000, 'MODEL_OUTPUT_TOO_LARGE', '模型输出超过长度限制。')
      const renderer = createRoleplayMacroStream(context.identities)
      const rendered = renderer.push(text) + (complete ? renderer.finish() : '')
      requireValue([...rendered].length <= 200_000, 'MODEL_OUTPUT_TOO_LARGE', '模型输出超过长度限制。')
      return rendered
    }
    const scope: RuntimeToolScope = { run, signal, owner: () => currentOwner, writerText: () => writerText,
      refreshContext: () => {
        context = this.contexts.freeze(runId, routes.main, resources.files, resources.specialists, resources.parentInstructions, contextPolicy)
        writerText = null; writerOwner = ''; recoveryNarrative = null; pendingRefresh = true
      },
    }
    const applySteering = () => {
      if (!this.inputs?.hasSteering(runId)) return
      this.inputs.consumeSteering(runId)
      resources.refreshInputs?.()
      this.turns.dispose(runId)
      scope.refreshContext()
    }
    const compact = async () => {
      requireValue(this.summaries && !overflowAttempted, 'CONTEXT_OVERFLOW', '本轮上下文压缩恢复已用尽；草稿与工具记录保留，请调整资料或模型。', 502)
      overflowAttempted = true
      await this.summaries.overflow(runId, routes.main, signal)
      context = this.contexts.compact(runId, context, writerText !== null)
      pendingRefresh = true
    }
    const writerSystemPrompt = () => context.writerSystemPrompt
    const writer: AgentTool = {
      name: 'rp_write_turn', label: '正文写作', description: mode === 'chat' ? CHAT_WRITER_TOOL_DESCRIPTION : AGENT_WRITER_TOOL_DESCRIPTION,
      parameters: Type.Object({ action: Type.Literal('write'), ...(mode === 'agent' ? { brief: Type.Optional(Type.String({ maxLength: 4096 })) } : {}) }, { additionalProperties: false }),
      execute: async (callId, input, toolSignal) => toolResult(async () => {
        objectInput(input)
        requireValue(writerText === null, 'WRITER_ALREADY_COMPLETED', 'Writer 已经完成，请提交当前正文。')
        resources.beforeWriter?.()
        const effectiveSignal = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal
        const result = await runIsolated(this.models, {
          route: routes.writer, systemPrompt: writerSystemPrompt(),
          prompt: renderWriterPrompt(context.writerPrompt, typeof input.brief === 'string' ? input.brief : undefined),
          images: resources.images, tools: resources.readonlyTools, maxSteps: resources.readonlyTools.length ? 6 : 1,
          maxParallelToolCalls: parallel, initialHistory: writerHistory,
          signal: effectiveSignal, identities: context.identities,
          streamFn: journalStream(journal, this.models, `writer:${callId}`, journal.callId(callId), writerHistory?.metadata),
          onText: (text, final) => persistDraft(text, final),
          onMessage: message => journal.model(journal.callId(callId), `writer:${String(message.role)}`, message),
          onEvent: event => journal.tool(event, `writer:${callId}`, journal.callId(callId)),
          ...(this.summaries ? { recoverOverflow: async () => { await compact(); return { systemPrompt: writerSystemPrompt(), prompt: renderWriterPrompt(context.writerPrompt, typeof input.brief === 'string' ? input.brief : undefined) } } } : {}),
        }).catch(error => {
          // An explicit provider block must not become a retryable parent tool failure.
          if (error instanceof RpError && error.code === 'MODEL_CONTENT_FILTER') terminalWriterError = error
          throw error
        })
        requireValue(!this.inputs?.hasSteering(runId), 'WRITER_INPUT_CHANGED', '用户刚刚补充了本轮要求；请先读取新输入，再重新调用 Writer。', 409)
        writerText = result.text
        writerOwner = currentOwner
        persistDraft(writerText, true)
        this.turns.recordWriter(runId, callId, context.seq, writerText, writerHistory?.metadata)
        return { text: writerText, contextSeq: context.seq }
      }),
    }
    const commit: AgentTool = {
      name: 'rp_commit_turn', label: '保存剧情', description: COMMIT_TOOL_DESCRIPTION,
      parameters: Type.Unsafe({ anyOf: [
        { type: 'object', additionalProperties: false, ...(mode === 'agent' ? { required: ['narrative'] } : {}), properties: {
          ...(mode === 'agent' ? { narrative: { type: 'string', minLength: 1, maxLength: 200_000, description: 'The complete final story prose only, after reviewing Writer and required specialists. Do not include process commentary or repeat it outside this field.' } } : {}),
          runSummary: { type: 'string', maxLength: 10_000, description: 'Optional concise factual summary of the final narrative; omitted uses a short excerpt.' },
          effects: { type: 'array', maxItems: stateEnabled ? 64 : 0, description: 'Persistent changes derived from the final narrative. Follow state_commit_contract, including each namespace updateMode and ruleIdRequirement. Omit or use [] when no values changed.', items: stateUpdateEffectSchema() },
          references: { type: 'array', maxItems: 128, items: { type: 'object', additionalProperties: false,
            properties: { source: { type: 'string' }, id: { type: 'string' }, revision: { type: ['string', 'number'] } }, required: ['source', 'id', 'revision'] } },
          extensions: { additionalProperties: false,
            description: resources.replyOptions ? 'Include reply options with the variable effects in this same commit, following the system reply-options instructions.' : 'Reply options are disabled; omit extensions or use {}.',
            // Advisory values are normalized after core validation; malformed options must not trigger a narrative retry.
            properties: { 'rp.reply-options': { description: 'Expected shape: {"options":["directly sendable next message", "another choice"]}. No version field is needed.' } },
          },
        } }, { type: 'object', additionalProperties: false, required: ['retry'], properties: { retry: commitRetryParameterSchema() } },
      ] }),
      execute: async (_callId, input) => {
        const result = await toolResult(async () => {
          objectInput(input)
          requireValue(!replied && !committed, 'RUN_STATE_CONFLICT', '本轮回复已经完成。', 409)
          requireValue(writerOwner !== currentOwner, 'WRITER_REVIEW_REQUIRED', '请读取 Writer 结果后，在下一条回复中提交正文。')
          const { narrative, ...commitInput } = input
          requireValue(mode === 'chat' || typeof narrative === 'string' && narrative.trim().length > 0 || 'retry' in input, 'NARRATIVE_REQUIRED', '请在剧情提交的 narrative 字段中提供完整正文。')
          const finalText = mode === 'agent' && typeof narrative === 'string' ? renderNarrative(narrative) : ''
          const event = await this.turns.commit(runId, currentOwner, finalText, commitInput, stateEnabled,
            () => {
              signal.throwIfAborted()
              requireValue(!this.inputs?.hasSteering(runId), 'COMMIT_INPUT_CHANGED', '用户刚刚补充了本轮要求；请先读取新输入，再重新准备正文。', 409)
              resources.beforeCommit?.()
            },
            resources.replyOptions?.enabled() ? resources.replyOptions.config : undefined)
          committed = true
          if (event.type === 'turn.committed') persistDraft(event.data.message.text, true)
          return { committed: true, messageId: event.type === 'turn.committed' ? event.data.message.id : currentOwner }
        })
        return { ...result, terminate: true }
      },
    }
    const reply: AgentTool = {
      name: 'rp_reply', label: '回答创作讨论',
      description: 'Finish a non-narrative response without changing story state or generating reply options. Before Writer, provide the complete discussion or clarification in text. After reviewing a Writer result that is a refusal, clarification question, or other non-narrative answer, call with only useWriterResult:true to deliver that saved text unchanged; do not retry Writer or invent story effects. Actual fictional prose must use rp_commit_turn.',
      parameters: Type.Union([
        Type.Object({ text: Type.String({ minLength: 1, maxLength: 200000 }) }, { additionalProperties: false }),
        Type.Object({ useWriterResult: Type.Literal(true) }, { additionalProperties: false }),
      ]),
      execute: async (_callId, input) => {
        const result = await toolResult(async () => {
          signal.throwIfAborted(); objectInput(input)
          requireValue(!replied && !committed, 'RUN_STATE_CONFLICT', '本轮回复已经完成。', 409)
          const fromWriter = input.useWriterResult === true
          requireValue(fromWriter ? writerText !== null : writerText === null, 'WRITER_REPLY_REQUIRED', fromWriter ? '请先读取 Writer 返回的结果。' : '已有 Writer 结果；非剧情回复请使用 useWriterResult 原样交付，正文请提交剧情。')
          requireValue(!fromWriter || writerOwner !== currentOwner, 'WRITER_REVIEW_REQUIRED', '请读取 Writer 结果后，再决定如何结束回复。')
          requireValue(fromWriter || typeof input.text === 'string' && input.text.trim().length > 0, 'REPLY_EMPTY', '讨论回复不能为空。')
          const renderer = createRoleplayMacroStream(context.identities)
          const text = fromWriter ? writerText! : renderer.push(input.text as string) + renderer.finish()
          this.stories.append(run.storyId, { type: 'message.added', data: { message: {
            id: currentOwner, role: 'assistant', kind: 'message', text, runId, turnId: run.turnId,
            attachmentIds: [], createdAt: new Date().toISOString(),
          } } })
          replied = true; persistDraft(text, true)
          return { replied: true, messageId: currentOwner }
        })
        return { ...result, terminate: true }
      },
    }
    const prune = contextPruner(value => journal.model(journal.callId(value.toolCallId), 'context:pruned', value))
    const mainStream = journalStream(journal, this.models, 'main')
    const agent = new Agent({
      initialState: { ...resolved, systemPrompt: context.systemPrompt, tools: boundedTools([writer, commit, reply, ...resources.tools(scope)], parallel), messages: conversation().filter(message => (message as ParentMessage).rpRunId !== runId) },
      streamFn: (model, request, options) => mainStream(model, { ...request, systemPrompt: context.systemPrompt }, options),
      toolExecution: parallel > 1 ? 'parallel' : 'sequential', sessionId: run.storyId,
      transformContext: () => {
        applySteering()
        return prune(conversation())
      },
      beforeToolCall: async () => committed || replied || terminalWriterError ? { block: true, reason: terminalWriterError?.message ?? '本轮回复已经完成。', terminate: true }
        : this.inputs?.hasSteering(runId) ? { block: true, reason: '用户补充了本轮要求。请先读取更新后的当前输入，再决定工具或重新写作。' } : undefined,
      shouldStopAfterTurn: () => { steps += 1; return signal.aborted || committed || replied || !!terminalWriterError || steps >= maxSteps },
      prepareNextTurnWithContext: ({ context: agentContext }) => {
        applySteering()
        if (!pendingRefresh) return undefined
        pendingRefresh = false
        return { context: { ...agentContext, systemPrompt: context.systemPrompt,
          messages: conversation(),
        } }
      },
    })
    const releaseInput = this.inputs?.register(runId, {
      validate: files => { requireValue(!committed && !replied, 'RUN_STATE_CONFLICT', '本轮回复已经完成，请加入待发消息。', 409); resources.validateInputFiles?.(files) },
      notify: () => agent.steer({ role: 'user', content: [{ type: 'text', text: 'The user has supplied an update to this turn.' }], timestamp: Date.now(), rpSource: 'steering' } as unknown as ParentMessage),
    })
    const cancel = () => agent.abort()
    signal.addEventListener('abort', cancel, { once: true })
    agent.subscribe(event => {
      if (event.type === 'message_start' && event.message.role === 'assistant') {
        currentOwner = randomUUID(); currentText = ''; macro = createRoleplayMacroStream(context.identities)
      }
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        currentText += macro.push(event.assistantMessageEvent.delta)
        requireValue([...currentText].length <= 200_000, 'MODEL_OUTPUT_TOO_LARGE', '模型输出超过长度限制。')
      }
      if (mode === 'agent' && writerText !== null && writerOwner !== currentOwner && event.type === 'message_update' && event.assistantMessageEvent.type === 'toolcall_delta' && recoveryNarrative === null) {
        const call = event.assistantMessageEvent.partial.content[event.assistantMessageEvent.contentIndex]
        if (call?.type === 'toolCall' && call.name === 'rp_commit_turn' && typeof call.arguments.narrative === 'string') {
          persistDraft(renderNarrative(call.arguments.narrative, false))
        }
      }
      if (event.type === 'message_end') {
        const source = (event.message as ParentMessage).rpSource as string | undefined
        journal.model(currentOwner, source === 'steering' ? 'runtime:steering' : event.message.role,
          event.message.role === 'user' ? { ...event.message, rpSource: source ?? 'runtime' } : event.message)
        if (event.message.role === 'assistant') {
          currentText += macro.finish()
          const hasTools = event.message.content.some(part => part.type === 'toolCall')
          const committing = event.message.content.find(part => part.type === 'toolCall' && part.name === 'rp_commit_turn' && typeof part.arguments.narrative === 'string' && !('retry' in part.arguments))
          if (mode === 'agent' && writerText !== null && committing?.type === 'toolCall' && recoveryNarrative === null) {
            recoveryNarrative = renderNarrative(committing.arguments.narrative)
            persistDraft(recoveryNarrative, true)
          }
          if (hasTools || mode === 'agent' && writerText === null && event.message.stopReason === 'stop' && currentText.trim()) {
            this.stories.append(run.storyId, { type: 'message.added', data: { message: {
              id: currentOwner, role: 'assistant', kind: hasTools ? 'tool' : 'message', text: currentText,
              runId, turnId: run.turnId, attachmentIds: [], createdAt: new Date().toISOString(),
            } } })
          }
        }
      }
      journal.tool(event)
    })
    try {
      this.summaries?.pressure(runId, [
        { route: routes.main, text: context.systemPrompt + JSON.stringify(conversation()) + JSON.stringify(agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))) },
        { route: routes.writer, text: writerSystemPrompt() + (writerHistory ? writerHistoryPreview(writerHistory.messages) : '') + context.writerPrompt + JSON.stringify(resources.readonlyTools.map(({ name, description, parameters }) => ({ name, description, parameters }))) },
      ], routes.main)
      const inputs = conversation().filter(message => (message as ParentMessage).rpRunId === runId)
      this.models.resolve(routes.main, conversation().flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image') as ImageContent[] : []))
      await agent.prompt(inputs)
      signal.throwIfAborted()
      if (terminalWriterError) throw terminalWriterError
      let last = agent.state.messages.findLast(message => message.role === 'assistant')
      if (!committed && last?.role === 'assistant' && isContextOverflow(last, resolved.model.contextWindow) && this.summaries) {
        await compact()
        signal.throwIfAborted()
        agent.state.systemPrompt = context.systemPrompt
        agent.state.messages = conversation()
        pendingRefresh = false; steps = Math.max(0, steps - 1)
        await agent.continue()
        signal.throwIfAborted()
        if (terminalWriterError) throw terminalWriterError
        last = agent.state.messages.findLast(message => message.role === 'assistant')
      }
      if (mode === 'chat' && !committed && !replied && last?.stopReason === 'stop' && !agent.state.errorMessage && steps < maxSteps) {
        // Continue the same model history once; never replay tools or publish an unfinalized narrative as discussion.
        await agent.prompt(writerText === null
          ? 'The last response did not finalize this Chat turn. Classify the current user request: fictional dialogue/actions or story continuation must call rp_write_turn followed by rp_commit_turn; only out-of-character discussion or inspection may finish with rp_reply. Do not publish the previous draft as discussion just to bypass Writer. Use the appropriate tool now; no plain-text-only answer.'
          : 'Writer has completed this call. Review its saved result: fictional prose must use rp_commit_turn; a refusal, clarification question, or other non-narrative answer must use rp_reply with only useWriterResult:true. Preserve the result and do not repeat Writer. If nothing changed in the story, omit effects or use effects:[]; never invent changes to satisfy validation.')
        signal.throwIfAborted()
        last = agent.state.messages.findLast(message => message.role === 'assistant')
      }
      if (terminalWriterError) throw terminalWriterError
      requireValue(last?.role !== 'assistant' || !isContextOverflow(last, resolved.model.contextWindow), 'CONTEXT_OVERFLOW', '模型上下文超限，已保留草稿与工具记录；请调整资料、本轮输入或模型。', 502)
      const providerError = last?.role === 'assistant' ? last.errorMessage ?? agent.state.errorMessage ?? '' : agent.state.errorMessage ?? ''
      requireValue(!providerError.includes('Provider finish_reason: content_filter'), 'MODEL_CONTENT_FILTER', '模型提供商的内容过滤中止了本轮生成，尚未提交正文。已有草稿和工具记录已保留。', 502)
      if (last?.role !== 'assistant' || last.stopReason === 'error' || agent.state.errorMessage) throw new RpError('MODEL_REQUEST_FAILED', '模型调用失败，请检查提供商配置与服务状态。', 502)
      requireValue(committed || replied || last.stopReason === 'stop', 'RUN_STEP_LIMIT', '本次生成未完成，请检查工具结果或增加生成步数。')
      requireValue(mode !== 'chat' || committed || replied, 'CHAT_RESPONSE_NOT_FINALIZED', '模型未完成剧情提交或讨论回复，请查看过程后重新生成。')
      requireValue(committed || replied || writerText === null, 'NARRATIVE_NOT_COMMITTED', '正文已生成，但剧情提交未完成。草稿已保留。')
      return { committed, steps, context }
    } finally {
      releaseInput?.()
      signal.removeEventListener('abort', cancel)
      this.turns.dispose(runId)
    }
  }
}
