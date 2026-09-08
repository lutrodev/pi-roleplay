import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { StoryRepository } from '../storage/story-repository.ts'
import { storyNotice } from '../../../../packages/protocol/src/reading.ts'

/** SQLite cursors cover both replay and live delivery, so no subscribe/snapshot race can lose events. */
export class EventStreams {
  private readonly connections = new Set<() => void>()
  private closing = false
  constructor(readonly stories: StoryRepository, readonly authenticated: (request: FastifyRequest) => boolean) {}

  register(app: FastifyInstance) {
    app.addHook('preClose', async () => { this.closing = true; for (const close of this.connections) close() })
    app.get<{ Params: { storyId: string }; Querystring: { after?: string } }>('/api/stories/:storyId/events', {
      schema: { params: { type: 'object', required: ['storyId'], properties: { storyId: { type: 'string', minLength: 1, maxLength: 128 } } },
        querystring: { type: 'object', additionalProperties: false, properties: { after: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' } } } },
    }, (request, reply) => this.open(request, reply, request.params.storyId, request.headers['last-event-id'] ?? request.query.after ?? '0'))
  }

  private async open(request: FastifyRequest, reply: FastifyReply, storyId: string, rawCursor: unknown) {
    requireValue(!this.closing && this.connections.size < 8, 'SSE_LIMIT', '实时连接数量达到上限，请关闭其他页面后重试。', 429)
    requireValue(typeof rawCursor === 'string' && /^(0|[1-9][0-9]*)$/.test(rawCursor), 'INVALID_CURSOR', '实时事件位置不正确。')
    let cursor = Number(rawCursor)
    requireValue(Number.isSafeInteger(cursor) && cursor <= this.stories.latestSequence(storyId), 'SSE_CURSOR_AHEAD', '事件位置已失效，请刷新故事后重新连接。', 409)
    const controller = new AbortController()
    const close = () => { controller.abort(); if (!reply.raw.writableEnded) reply.raw.end() }
    this.connections.add(close)
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    reply.raw.on('close', close)
    const write = async (text: string) => {
      controller.signal.throwIfAborted()
      if (!reply.raw.write(text)) await once(reply.raw, 'drain', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
    }
    let heartbeat = Date.now()
    try {
      await write(': connected\n\n')
      while (!controller.signal.aborted) {
        if (!this.authenticated(request)) break
        if (!this.stories.exists(storyId)) { await write('event: story-deleted\ndata: {}\n\n'); break }
        const events = this.stories.eventBatch(storyId, cursor)
        for (const event of events) {
          await write(`id: ${event.seq}\nevent: story\ndata: ${JSON.stringify(storyNotice(event))}\n\n`)
          cursor = event.seq
        }
        if (Date.now() - heartbeat >= 15000) { await write(': heartbeat\n\n'); heartbeat = Date.now() }
        if (events.length < 50) await delay(250, undefined, { signal: controller.signal })
      }
    } catch (error) {
      if (!controller.signal.aborted && !reply.raw.destroyed) {
        request.log.warn({ code: error instanceof Error ? error.name : 'SSE_ERROR' }, 'Story event stream closed')
        reply.raw.end('event: stream-error\ndata: {"code":"SSE_CLOSED"}\n\n')
      }
    } finally { this.connections.delete(close); reply.raw.removeListener('close', close); close() }
  }
}
