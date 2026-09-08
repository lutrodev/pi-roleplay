import { setTimeout as pause } from 'node:timers/promises'

/** Real incremental SSE for inspecting main-model progress before a tool starts. */
export function activityResponse(text: string, call: { name: string; args: object }, signal?: AbortSignal | null) {
  const stopped = new AbortController(), cancellation = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal
  const characters = [...text], encoder = new TextEncoder()
  let offset = 0
  const frame = (delta: object, finish_reason: string | null) => encoder.encode(`data: ${JSON.stringify({ id: 'activity-preview', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        cancellation.throwIfAborted()
        if (offset < characters.length) {
          if (offset) await pause(900, undefined, { signal: cancellation })
          controller.enqueue(frame({ ...(offset === 0 ? { role: 'assistant' } : {}), content: characters.slice(offset, offset + 4).join('') }, null)); offset += 4
        } else {
          controller.enqueue(frame({ tool_calls: [{ index: 0, id: `activity-${call.name}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, 'tool_calls'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close()
        }
      } catch (error) { controller.error(error) }
    },
    cancel() { stopped.abort() },
  }), { headers: { 'content-type': 'text/event-stream' } })
}
