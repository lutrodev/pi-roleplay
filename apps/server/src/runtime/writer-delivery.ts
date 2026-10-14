import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core'
import { Type, type AssistantMessage } from '@earendil-works/pi-ai'
import { writerDeliveryTemplate, type WriterDelivery } from '../../../../packages/rp-core/src/agents/writer-delivery.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { createRoleplayMacroStream } from '../../../../packages/rp-core/src/macro/syntax.js'

const outputLimit = 200_000
const invalidOutput = () => new RpError('WRITER_DELIVERY_INVALID', 'Writer 正文交付不完整：需要单独调用指定工具，返回完整、非空的正文字段。', 502)

/** An in-process output sink. It never reads a file, dispatches a command, or commits story state. */
export class WriterDeliverySession {
  attempted = false
  private delivered = false
  private error: Error | undefined
  private pending: { callId: string; text: string } | undefined
  private raw = new Map<number, string>()
  private preview = ''
  private finalText = ''

  constructor(readonly config: WriterDelivery, readonly onText?: (text: string, final: boolean) => void,
    readonly identities?: { userName?: string; characterName?: string }) {}

  system(base: string) {
    return `${base}\n\n${writerDeliveryTemplate(this.config.system, this.config)}\n\nWriter delivery for this run: the complete Writer reply must be delivered by calling ${this.config.toolName} with the single string field ${this.config.fieldName}. This replaces only the default plain-text delivery channel. Read-only reference tools remain available; use them before delivery when needed. Call the delivery tool exactly once, in a message without other tool calls. It accepts output only and performs no file, shell, or story-state operations. The reply may be narrative or a clarification/refusal; the parent still decides how to present or commit it.`
  }

  get invocation() { return writerDeliveryTemplate(this.config.invocation, this.config) }

  tools(readonlyTools: AgentTool[], context: string): AgentTool[] {
    requireValue(!readonlyTools.some(tool => tool.name === this.config.toolName), 'WRITER_DELIVERY_CONFLICT', '正文交付工具名与 Writer 的只读工具重名，请更换交付工具名。')
    const tool: AgentTool = {
      name: this.config.toolName, label: 'Writer 正文交付',
      description: `${writerDeliveryTemplate(this.config.toolDescription, this.config)}\n\n<writer_context>\n${context}\n</writer_context>`,
      parameters: Type.Object({ [this.config.fieldName]: Type.String({ minLength: 1, maxLength: outputLimit,
        description: writerDeliveryTemplate(this.config.fieldDescription, this.config) }) }, { additionalProperties: false }),
      execute: async (id, _args, signal) => {
        signal?.throwIfAborted()
        if (this.error) throw this.error
        if (!this.pending || this.pending.callId !== id || this.delivered) throw invalidOutput()
        this.finalText = this.render(this.pending.text, true)
        this.delivered = true
        return { content: [{ type: 'text', text: '{"received":true}' }], details: { received: true } }
      },
    }
    return [...readonlyTools, tool]
  }

  observe(event: AgentEvent) {
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      this.attempted = false; this.delivered = false; this.error = undefined; this.pending = undefined
      this.raw.clear(); this.preview = ''; this.finalText = ''
    }
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent
      if (update.type !== 'toolcall_delta' && update.type !== 'toolcall_start' && update.type !== 'toolcall_end') return
      const call = update.partial.content[update.contentIndex]
      if (call?.type !== 'toolCall' || call.name !== this.config.toolName) return
      this.attempted = true
      if (update.type === 'toolcall_delta') {
        const raw = (this.raw.get(update.contentIndex) ?? '') + update.delta
        if (raw.length > 2_500_000) { this.error = invalidOutput(); return }
        this.raw.set(update.contentIndex, raw)
      }
      const partial = call.arguments[this.config.fieldName]
      if (typeof partial === 'string' && !this.error) this.publish(partial, false)
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') this.finishMessage(event.message)
  }

  private finishMessage(message: AssistantMessage) {
    const calls = message.content.filter(block => block.type === 'toolCall')
    const call = calls.find(block => block.name === this.config.toolName)
    this.attempted ||= !!call
    if (!call) { if (this.attempted) this.onText?.(this.preview, true); return }
    try {
      if (this.error) throw this.error
      if (message.stopReason !== 'toolUse' || calls.length !== 1) throw invalidOutput()
      const raw = this.raw.get(message.content.indexOf(call))
      // Pi repairs partial JSON for display. A repaired/truncated JSON string must never become final prose.
      const args: unknown = raw === undefined ? call.arguments : JSON.parse(raw)
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1
        || !Object.hasOwn(args, this.config.fieldName)) throw invalidOutput()
      const text = (args as Record<string, unknown>)[this.config.fieldName]
      if (typeof text !== 'string' || !text.trim()) throw invalidOutput()
      this.publish(text, true)
      this.pending = { callId: call.id, text }
    } catch (error) {
      this.error = error instanceof RpError ? error : invalidOutput()
      this.onText?.(this.preview, true)
    }
  }

  private render(source: string, final: boolean) {
    requireValue([...source].length <= outputLimit, 'MODEL_OUTPUT_TOO_LARGE', '模型输出超过长度限制。')
    const macro = createRoleplayMacroStream(this.identities)
    const text = macro.push(source) + (final ? macro.finish() : '')
    requireValue([...text].length <= outputLimit, 'MODEL_OUTPUT_TOO_LARGE', '模型输出超过长度限制。')
    return text
  }

  private publish(source: string, final: boolean) {
    try {
      const text = this.render(source, final)
      if (text !== this.preview || final) { this.preview = text; this.onText?.(text, final) }
    } catch (error) { this.error = error instanceof Error ? error : invalidOutput() }
  }

  result() {
    if (this.error) throw this.error
    if (!this.delivered || !this.finalText.trim()) throw invalidOutput()
    return this.finalText
  }
}
