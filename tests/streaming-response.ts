import { setTimeout as pause } from 'node:timers/promises'

/** Deliberately slow, real SSE chunks so tests can inspect prose before the model completes. */
export function streamingTextResponse(text: string, signal?: AbortSignal | null) {
  const cancellation = new AbortController(), stopped = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal
  const encoder = new TextEncoder(), characters = [...text]
  let offset = 0
  const frame = (delta: object, finish_reason: string | null) => encoder.encode(`data: ${JSON.stringify({ id: 'browser-streaming-prose', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        stopped.throwIfAborted()
        if (offset < characters.length) {
          if (offset) await pause(900, undefined, { signal: stopped })
          controller.enqueue(frame({ ...(offset === 0 ? { role: 'assistant' } : {}), content: characters.slice(offset, offset + 14).join('') }, null))
          offset += 14
        } else {
          controller.enqueue(frame({}, 'stop')); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close()
        }
      } catch (error) { controller.error(error) }
    },
    cancel() { cancellation.abort() },
  }), { headers: { 'content-type': 'text/event-stream' } })
}
