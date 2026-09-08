import { Type } from '@earendil-works/pi-ai'
import { normalizeReplyOptionsInput, renderReplyOptionsPrompt, replyOptionsOutputSchema, REPLY_OPTIONS_EXTENSION_NAMESPACE } from '../../../../packages/rp-core/src/interaction/reply-options.js'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { ModelRoute } from '../../../../packages/rp-core/src/types.ts'
import type { Preferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import type { ModelRegistry } from '../runtime/models.ts'
import type { RunJournal } from '../runtime/journal.ts'
import type { ContextService } from './context-service.ts'
import type { CommitGeneration, GeneratedCommit } from './turn-service.ts'

const outputName = 'emit_reply_options'
interface ReplyOptionsRequest {
  commit: CommitGeneration
  route: ModelRoute
  config: Preferences['replyOptions']
  context: Pick<ReturnType<ContextService['freeze']>, 'seq' | 'replyOptionsContext' | 'replyOptionsPlayer'>
  journal: RunJournal
  signal: AbortSignal
  enabled: () => boolean
}

/** Generate an advisory extension inside rp_commit_turn, before anything is published. */
export class ReplyOptionsService {
  private readonly active = new Set<AbortController>()
  constructor(readonly models: ModelRegistry) {}

  async generate({ commit, route, config, context, journal, signal: parentSignal, enabled }: ReplyOptionsRequest): Promise<GeneratedCommit> {
    parentSignal.throwIfAborted()
    const empty = { extensions: {}, diagnostics: [] }
    if (!enabled()) return empty
    const controller = new AbortController(), timeout = AbortSignal.timeout(30000)
    const signal = AbortSignal.any([parentSignal, controller.signal, timeout])
    this.active.add(controller)
    try {
      const { model, thinkingLevel } = this.models.resolve(route)
      requireValue(context.seq === commit.contextSeq, 'REPLY_OPTIONS_CONTEXT_CHANGED', '本轮写作资料版本不一致，无法生成回复选项。')
      const prompt = renderReplyOptionsPrompt({ narrative: commit.message.text, roleplayContext: context.replyOptionsContext(commit.state, commit.message), playerIdentity: context.replyOptionsPlayer, ...config })
      const tool = { name: outputName, description: 'Return the complete structured continuation options, without changing the story.', parameters: Type.Unsafe(replyOptionsOutputSchema(config.count, config.keywords, config.maxCharacters)) }
      const systemPrompt = '根据即将提交的最终正文生成用户可选择的下一步。只调用 emit_reply_options 返回结构化结果；不调用其他工具，不声明故事状态已改变。'
      journal.model(commit.message.id, 'reply-options:request', { route, systemPrompt, prompt, tool })
      const result = await this.models.stream(model, { systemPrompt, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }], tools: [tool] }, {
        signal, timeoutMs: 30000, maxRetries: 0, maxTokens: Math.min(2048, model.maxTokens), ...(thinkingLevel === 'off' ? {} : { reasoning: thinkingLevel }),
      }).result()
      signal.throwIfAborted()
      journal.model(commit.message.id, 'reply-options:response', result)
      requireValue(result.stopReason === 'toolUse', 'REPLY_OPTIONS_INCOMPLETE', '回复选项未返回完整的结构化结果。')
      const calls = result.content.filter(part => part.type === 'toolCall')
      requireValue(calls.length === 1 && calls[0]!.name === outputName, 'REPLY_OPTIONS_INCOMPLETE', '回复选项未返回预期的结构化结果。')
      const value = normalizeReplyOptionsInput(calls[0]!.arguments, config.count)
      return enabled() ? { extensions: { [REPLY_OPTIONS_EXTENSION_NAMESPACE]: value }, diagnostics: [] } : empty
    } catch (error) {
      // Turning off suggestions only cancels this generation; stopping the run cancels the commit.
      parentSignal.throwIfAborted()
      if (controller.signal.aborted || !enabled()) return empty
      const diagnostic = { source: REPLY_OPTIONS_EXTENSION_NAMESPACE, severity: 'warning' as const,
        code: timeout.aborted ? 'REPLY_OPTIONS_TIMEOUT' : 'REPLY_OPTIONS_FAILED',
        message: timeout.aborted ? '回复选项生成超时，正文与状态仍正常保存。' : '回复选项生成失败，已保存的正文不受影响。',
      }
      journal.model(commit.message.id, 'reply-options:diagnostic', { ...diagnostic, cause: error instanceof Error ? error.message : String(error) })
      return { extensions: {}, diagnostics: [diagnostic] }
    } finally {
      this.active.delete(controller)
    }
  }

  cancelAll() { for (const controller of this.active) controller.abort() }
}
