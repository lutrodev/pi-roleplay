import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import { RpError } from '../../../../packages/rp-core/src/errors.ts'
import type { StoryProfile, QuestionAnswer } from '../../../../packages/rp-core/src/types.ts'
import type { StoryService } from '../services/story-service.ts'
import type { QuestionService } from '../services/question-service.ts'
import type { RunQueue } from '../runtime/queue.ts'
import { projectRunTools } from '../../../../packages/rp-core/src/story/tool-records.ts'
import { replyState } from '../../../../packages/rp-core/src/story/reply-state.ts'
import { messagePage, readingView, recapPage } from '../../../../packages/protocol/src/reading.ts'
import { searchStories } from '../services/story-search.ts'
import type { WorkspaceService } from '../services/workspace-service.ts'
import type { StoryDeletionService } from '../services/story-deletion-service.ts'

const id = Type.String({ minLength: 1, maxLength: 128 }), revision = Type.Integer({ minimum: 1 }), strict = { additionalProperties: false }
const storyParams = Type.Object({ storyId: id }, strict), messageParams = Type.Object({ storyId: id, messageId: id }, strict)
const revisionBody = Type.Object({ expectedRevision: revision }, strict)
type StoryParams = { storyId: string }
type MessageParams = StoryParams & { messageId: string }
type Revision = { expectedRevision: number }

export function registerStoryRoutes(app: FastifyInstance, service: StoryService, queue: RunQueue, questions: QuestionService, workspaces: WorkspaceService, deletion: StoryDeletionService) {
  const stories = service.repository
  app.get<{ Querystring: { archived?: string; q?: string } }>('/api/stories', { schema: { querystring: Type.Object({ archived: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])), q: Type.Optional(Type.String({ maxLength: 300 })) }, strict) } },
    async request => ({ stories: searchStories(stories, request.query.archived === 'true', request.query.q).map(story => ({ ...story, workspaceId: stories.workspaceBinding(story.id).workspaceId })) }))
  app.post<{ Body: { requestId?: string; title: string; profile?: Partial<StoryProfile>; useDefaults?: boolean; workspaceId?: string } }>('/api/stories', {
    schema: { body: Type.Object({ requestId: Type.Optional(Type.String({ format: 'uuid' })), title: Type.String({ minLength: 1, maxLength: 120 }), useDefaults: Type.Optional(Type.Boolean()), profile: Type.Optional(Type.Object({}, { additionalProperties: true })), workspaceId: Type.Optional(id) }, strict) },
  }, async (request, reply) => reply.code(201).send({ story: stories.database.transaction(() => {
    const { requestId, title, profile, useDefaults, workspaceId } = request.body
    const key = `create:${createHash('sha256').update(JSON.stringify({ title, profile, useDefaults, workspaceId })).digest('hex')}`
    if (requestId && stories.exists(requestId)) {
      if (!stories.findEvent(requestId, key)) throw new RpError('REQUEST_CONFLICT', '这次创建标识已用于另一份内容，请重新创建。', 409)
      return stories.snapshot(requestId)
    }
    if (workspaceId) workspaces.get(workspaceId)
    const story = service.create(title, profile, useDefaults, requestId ? { id: requestId, key } : undefined)
    if (workspaceId) workspaces.associate(story.id, workspaces.storyInfo(story.id).revision, workspaceId)
    return stories.snapshot(story.id)
  }) }))
  app.post<{ Body: { requestId: string; title: string; profile?: Partial<StoryProfile>; useDefaults?: boolean; workspaceId?: string; inputs: { text: string; attachmentIds: string[] }[] } }>('/api/stories/start', {
    bodyLimit: 4194304,
    schema: { body: Type.Object({ requestId: Type.String({ format: 'uuid' }), title: Type.String({ minLength: 1, maxLength: 120 }), profile: Type.Optional(Type.Object({}, { additionalProperties: true })), useDefaults: Type.Optional(Type.Boolean()), workspaceId: Type.Optional(id), inputs: Type.Array(Type.Object({ text: Type.String({ maxLength: 200000 }), attachmentIds: Type.Array(id, { maxItems: 16 }) }, strict), { minItems: 1, maxItems: 16 }) }, strict) },
  }, async (request, reply) => {
    const { requestId, title, profile, useDefaults, workspaceId, inputs } = request.body
    const key = `start:${createHash('sha256').update(JSON.stringify({ title, profile, useDefaults, workspaceId, inputs })).digest('hex')}`
    const result = stories.database.transaction(() => {
      if (stories.exists(requestId)) {
        if (!stories.findEvent(requestId, key)) throw new RpError('REQUEST_CONFLICT', '这次发送标识已用于另一份内容，请重新发送。', 409)
        return { storyId: requestId, duplicate: true }
      }
      if (workspaceId) workspaces.get(workspaceId)
      const story = service.create(title, profile, useDefaults, { id: requestId, key })
      if (workspaceId) workspaces.associate(story.id, workspaces.storyInfo(story.id).revision, workspaceId)
      service.send(story.id, requestId, inputs)
      return { storyId: story.id, duplicate: false }
    })
    queue.wake(); return reply.code(202).send(result)
  })
  app.get<{ Params: StoryParams }>('/api/stories/:storyId', { schema: { params: storyParams } },
    async request => {
      const story = stories.snapshot(request.params.storyId)
      return { ...readingView(story), forkSourceAvailable: !story.forkedFrom || stories.exists(story.forkedFrom.storyId), runs: stories.storyRuns(story.id, 30, story.conversationRunId)
        .map(run => run.id === story.conversationRunId || ['queued', 'running', 'waiting_user'].includes(run.status) ? run : { ...run, draft: '' }) }
    })
  app.delete<{ Params: StoryParams; Body: Revision }>('/api/stories/:storyId', {
    schema: { params: storyParams, body: revisionBody },
  }, async (request, reply) => { deletion.delete(request.params.storyId, request.body.expectedRevision); return reply.code(204).send() })
  app.get<{ Params: StoryParams; Querystring: { before: string } }>('/api/stories/:storyId/messages', {
    schema: { params: storyParams, querystring: Type.Object({ before: id }, strict) },
  }, async request => messagePage(stories.snapshot(request.params.storyId), request.query.before))
  app.get<{ Params: StoryParams; Querystring: { before?: string } }>('/api/stories/:storyId/runs', {
    schema: { params: storyParams, querystring: Type.Object({ before: Type.Optional(id) }, strict) },
  }, async request => stories.runPage(request.params.storyId, request.query.before))
  app.get<{ Params: StoryParams; Querystring: { before?: string } }>('/api/stories/:storyId/recap', {
    schema: { params: storyParams, querystring: Type.Object({ before: Type.Optional(id) }, strict) },
  }, async request => recapPage(stories.snapshot(request.params.storyId), request.query.before))
  app.get<{ Params: MessageParams }>('/api/stories/:storyId/messages/:messageId/state', { schema: { params: messageParams } },
    async request => replyState(stories.projectionEvents(request.params.storyId), request.params.messageId))
  app.get<{ Params: StoryParams }>('/api/stories/:storyId/rounds', { schema: { params: storyParams } }, async request => {
    const snapshot = stories.snapshot(request.params.storyId), seen = new Set<string>()
    let index = 0
    return { rounds: snapshot.messages.filter(message => {
      if (message.kind === 'tool' || seen.has(message.turnId)) return false
      seen.add(message.turnId); return true
    }).map(message => ({ index: message.kind === 'opening' ? 0 : ++index, messageId: message.id, runId: message.runId, createdAt: message.createdAt, preview: [...message.text].slice(0, 120).join(''), opening: message.kind === 'opening' })) }
  })
  app.put<{ Params: MessageParams; Body: Revision & { rating: 'up' | 'down' | null; comment: string } }>('/api/stories/:storyId/messages/:messageId/feedback', {
    schema: { params: messageParams, body: Type.Object({ expectedRevision: revision, rating: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Null()]), comment: Type.String({ maxLength: 4000 }) }, strict) },
  }, async request => ({ story: service.feedback(request.params.storyId, request.body.expectedRevision, request.params.messageId, request.body.rating, request.body.comment) }))
  app.put<{ Params: StoryParams; Body: Revision & { profile: StoryProfile } }>('/api/stories/:storyId/profile', {
    bodyLimit: 262144,
    schema: { params: storyParams, body: Type.Object({ expectedRevision: revision, profile: Type.Object({}, { additionalProperties: true }) }, strict) },
  }, async request => ({ story: service.updateProfile(request.params.storyId, request.body.expectedRevision, request.body.profile) }))
  app.patch<{ Params: StoryParams; Body: Revision & { title: string } }>('/api/stories/:storyId/title', {
    schema: { params: storyParams, body: Type.Object({ expectedRevision: revision, title: Type.String({ minLength: 1, maxLength: 120 }) }, strict) },
  }, async request => { service.rename(request.params.storyId, request.body.expectedRevision, request.body.title); return { story: stories.snapshot(request.params.storyId) } })
  app.patch<{ Params: StoryParams; Body: Revision & { archived: boolean } }>('/api/stories/:storyId/archive', {
    schema: { params: storyParams, body: Type.Object({ expectedRevision: revision, archived: Type.Boolean() }, strict) },
  }, async request => { service.archive(request.params.storyId, request.body.expectedRevision, request.body.archived); if (!request.body.archived) queue.wake(); return { story: stories.snapshot(request.params.storyId) } })
  app.post<{ Params: StoryParams; Body: { requestId: string; inputs: { text: string; attachmentIds: string[] }[] } }>('/api/stories/:storyId/messages', {
    schema: { params: storyParams, body: Type.Object({ requestId: id, inputs: Type.Array(Type.Object({ text: Type.String({ maxLength: 200000 }), attachmentIds: Type.Array(id, { maxItems: 16 }) }, strict), { minItems: 1, maxItems: 16 }) }, strict) },
  }, async (request, reply) => {
    const result = service.send(request.params.storyId, request.body.requestId, request.body.inputs)
    queue.wake(); return reply.code(202).send(result)
  })
  app.patch<{ Params: MessageParams; Body: Revision & { text: string } }>('/api/stories/:storyId/messages/:messageId', {
    schema: { params: messageParams, body: Type.Object({ expectedRevision: revision, text: Type.String({ minLength: 1, maxLength: 200000 }) }, strict) },
  }, async request => ({ story: service.edit(request.params.storyId, request.body.expectedRevision, request.params.messageId, request.body.text) }))
  app.delete<{ Params: MessageParams; Body: Revision }>('/api/stories/:storyId/messages/:messageId', {
    schema: { params: messageParams, body: revisionBody },
  }, async request => ({ story: service.remove(request.params.storyId, request.body.expectedRevision, request.params.messageId) }))
  app.post<{ Params: MessageParams; Body: Revision & { requestId: string; editedText?: string } }>('/api/stories/:storyId/messages/:messageId/regenerate', {
    schema: { params: messageParams, body: Type.Object({ expectedRevision: revision, requestId: id, editedText: Type.Optional(Type.String({ minLength: 1, maxLength: 200000 })) }, strict) },
  }, async (request, reply) => {
    const result = service.regenerate(request.params.storyId, request.body.expectedRevision, request.params.messageId, request.body.requestId, request.body.editedText)
    queue.wake(); return reply.code(202).send(result)
  })
  app.post<{ Params: MessageParams; Body: Revision }>('/api/stories/:storyId/messages/:messageId/fork', {
    schema: { params: messageParams, body: revisionBody },
  }, async (request, reply) => reply.code(201).send({ story: service.fork(request.params.storyId, request.body.expectedRevision, request.params.messageId) }))
  app.post<{ Params: StoryParams & { questionId: string }; Body: { answers: QuestionAnswer[] } }>('/api/stories/:storyId/questions/:questionId/answer', {
    schema: { params: Type.Object({ storyId: id, questionId: id }, strict), body: Type.Object({ answers: Type.Array(Type.Object({ id, selected: Type.Array(Type.String({ maxLength: 160 }), { maxItems: 12 }), custom: Type.Optional(Type.String({ maxLength: 4000 })) }, strict), { minItems: 1, maxItems: 8 }) }, strict) },
  }, async request => questions.answer(request.params.storyId, request.params.questionId, request.body.answers))
  const runParams = Type.Object({ runId: id }, strict)
  app.get<{ Params: { runId: string } }>('/api/runs/:runId', { schema: { params: runParams } }, async request => ({ run: stories.run(request.params.runId) }))
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/tools', { schema: { params: runParams } }, async request => {
    const run = stories.run(request.params.runId)
    return { tools: projectRunTools(stories.toolEvents(run.storyId, run.id), run.id) }
  })
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/stop', { schema: { params: runParams } }, async request => {
    const run = stories.run(request.params.runId)
    if (['queued', 'running', 'waiting_user'].includes(run.status)) await queue.cancel(run.id)
    return { run: stories.run(run.id) }
  })
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/context', { schema: { params: runParams } }, async request => {
    const run = stories.run(request.params.runId)
    const contexts = stories.eventsOfTypes(run.storyId, ['context.built', 'context.compacted'], { field: 'runId', value: run.id })
    if (contexts.length === 0) throw new RpError('CONTEXT_NOT_BUILT', '本次执行还没有准备写作上下文。', 404)
    return { contexts }
  })
}
