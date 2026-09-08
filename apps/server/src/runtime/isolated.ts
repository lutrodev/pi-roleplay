import { Agent, type AgentEvent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core'
import { isContextOverflow, type ImageContent } from '@earendil-works/pi-ai'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { createRoleplayMacroStream } from '../../../../packages/rp-core/src/macro/syntax.js'
import type { JsonObject, ModelRoute } from '../../../../packages/rp-core/src/types.ts'
import type { ModelRegistry } from './models.ts'
import { contextPruner } from './tool-pruner.ts'
import { boundedTools } from './tool-concurrency.ts'
import type { FrozenWriterHistory } from '../../../../packages/rp-core/src/agents/writer-history.ts'
import { nativeWriterHistory } from './writer-history.ts'

export interface IsolatedRequest {
  route: ModelRoute
  systemPrompt: string
  prompt: string
  images: ImageContent[]
  tools: AgentTool[]
  maxSteps: number
  maxParallelToolCalls?: number
  signal: AbortSignal
  identities?: { userName?: string; characterName?: string }
  /** Final means the message ended, including errors and cancellation, so buffered prose must be flushed. */
  onText?: (text: string, final: boolean) => void
  onMessage?: (message: JsonObject) => void
  onEvent?: (event: AgentEvent) => void
  streamFn?: StreamFn
  initialHistory?: FrozenWriterHistory
  recoverOverflow?: () => Promise<{ systemPrompt: string; prompt: string }>
}

/** A new Pi Agent is created for every call. It never receives the parent's model transcript. */
export async function runIsolated(models: ModelRegistry, request: IsolatedRequest) {
  request.signal.throwIfAborted()
  const { model, thinkingLevel } = models.resolve(request.route, request.images)
  let steps = 0
  let text = ''
  let macro = createRoleplayMacroStream(request.identities)
  const parallel = request.maxParallelToolCalls ?? 1
  const history = nativeWriterHistory(request.initialHistory, model), historyCount = history.length
  const prune = contextPruner(value => request.onMessage?.({ role: 'context:pruned', ...value }))
  const agent = new Agent({
    initialState: { model, thinkingLevel, systemPrompt: request.systemPrompt, tools: boundedTools(request.tools, parallel), messages: history },
    streamFn: request.streamFn ?? models.stream.bind(models), toolExecution: parallel > 1 ? 'parallel' : 'sequential',
    transformContext: async messages => [...messages.slice(0, historyCount), ...await prune(messages.slice(historyCount))],
    shouldStopAfterTurn: () => request.signal.aborted || ++steps >= request.maxSteps,
  })
  const cancel = () => agent.abort()
  request.signal.addEventListener('abort', cancel, { once: true })
  agent.subscribe(event => {
    request.onEvent?.(event)
    if (event.type === 'message_start' && event.message.role === 'assistant') { text = ''; macro = createRoleplayMacroStream(request.identities) }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      text += macro.push(event.assistantMessageEvent.delta)
      requireValue([...text].length <= 200_000, 'MODEL_OUTPUT_TOO_LARGE', '模型输出超过长度限制。')
      request.onText?.(text, false)
    }
    if (event.type === 'message_end') {
      if (event.message.role === 'assistant') { text += macro.finish(); request.onText?.(text, true) }
      request.onMessage?.(JSON.parse(JSON.stringify(event.message)))
    }
  })
  try {
    await agent.prompt(request.prompt, request.images)
    request.signal.throwIfAborted()
    let last = agent.state.messages.slice(historyCount + 1).findLast(message => message.role === 'assistant')
    if (last?.role === 'assistant' && isContextOverflow(last, model.contextWindow) && request.recoverOverflow) {
      const replacement = await request.recoverOverflow()
      request.signal.throwIfAborted()
      const messages = agent.state.messages
      const input = messages[historyCount]
      requireValue(messages.at(-1) === last && input?.role === 'user', 'CONTEXT_RECOVERY_INVALID', '当前模型记录不支持安全续接。', 502)
      agent.state.systemPrompt = replacement.systemPrompt
      agent.state.messages = [...messages.slice(0, historyCount), { ...input, content: [{ type: 'text', text: replacement.prompt }, ...request.images] }, ...messages.slice(historyCount + 1, -1)]
      steps = Math.max(0, steps - 1)
      await agent.continue()
      request.signal.throwIfAborted()
      last = agent.state.messages.slice(historyCount + 1).findLast(message => message.role === 'assistant')
    }
    requireValue(last?.role !== 'assistant' || !isContextOverflow(last, model.contextWindow), 'CONTEXT_OVERFLOW', '模型上下文超限，已保留草稿与工具记录；请调整资料、本轮输入或模型。', 502)
    const providerError = last?.role === 'assistant' ? last.errorMessage ?? agent.state.errorMessage ?? '' : agent.state.errorMessage ?? ''
    requireValue(!providerError.includes('Provider finish_reason: content_filter'), 'MODEL_CONTENT_FILTER', '模型提供商中止了本轮生成，尚未提交正文。已有草稿和工具记录已保留。', 502)
    if (last?.role !== 'assistant' || last.stopReason === 'error' || agent.state.errorMessage) throw new RpError('MODEL_REQUEST_FAILED', '模型调用失败，请检查提供商配置与服务状态。', 502)
    requireValue(last.stopReason !== 'length', 'MODEL_OUTPUT_TRUNCATED', '模型输出达到长度上限，本次内容未提交。')
    requireValue(last.stopReason === 'stop' && text.trim().length > 0, 'MODEL_OUTPUT_INCOMPLETE', '模型未完成正文，请检查工具或生成步数限制。')
    return { text, usage: last.usage }
  } finally { request.signal.removeEventListener('abort', cancel) }
}
