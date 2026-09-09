import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, lt, max, notInArray, or, sql } from 'drizzle-orm'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { projectStory } from '../../../../packages/rp-core/src/story/projection.ts'
import { requireStateNamespaceCapacity } from '../../../../packages/rp-core/src/state/limits.ts'
import type { JsonObject, RunRecord, RunStatus, StoryEvent, StoryEventInput, StoryProfile, StoryState } from '../../../../packages/rp-core/src/types.ts'
import type { AppDatabase } from './database.ts'
import { events, runs, stories } from './schema.ts'
import type { WorkspaceBinding } from '../../../../packages/rp-core/src/workspace.ts'

const PENDING: RunStatus[] = ['queued', 'running', 'waiting_user']
const DIAGNOSTIC_EVENTS: StoryEventInput['type'][] = ['context.built', 'context.compacted', 'writer.completed', 'model.message', 'run.draft', 'maintenance.model', 'history.inherited']
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['waiting_user', 'completed', 'failed', 'cancelled', 'interrupted'],
  waiting_user: ['running', 'failed', 'cancelled', 'interrupted'],
  completed: [], failed: [], cancelled: [], interrupted: [],
}

export class StoryRepository {
  constructor(readonly database: AppDatabase) {}

  create(title: string, profile: StoryProfile, bootstrap: StoryState = { namespaces: {} }, forkedFrom?: { storyId: string; messageId: string }, creation?: { id: string; key: string }) {
    return this.database.transaction(() => {
      requireStateNamespaceCapacity(Object.keys(bootstrap.namespaces).length)
      const id = creation?.id ?? randomUUID()
      requireValue(!this.database.sqlite.prepare('SELECT id FROM deleted_stories WHERE id = ?').get(id), 'STORY_DELETED', '这次创建对应的会话已删除，请重新发起新会话。', 409)
      const now = new Date().toISOString()
      this.database.orm.insert(stories).values({ id, title, createdAt: now, updatedAt: now }).run()
      this.append(id, { type: 'story.created', data: { title, profile, bootstrap, ...(forkedFrom ? { forkedFrom } : {}) } }, creation?.key)
      if (forkedFrom) this.append(id, { type: 'workspace.changed', data: this.workspaceBinding(forkedFrom.storyId) })
      return this.snapshot(id)
    })
  }

  exists(id: string) { return !!this.database.orm.select({ id: stories.id }).from(stories).where(eq(stories.id, id)).get() }

  list(archived = false) {
    return this.database.orm.select().from(stories).where(eq(stories.archived, archived)).orderBy(desc(stories.updatedAt)).all()
  }

  /** Old branches inherit their lineage; new branches freeze the binding when created. */
  workspaceBinding(storyId: string): WorkspaceBinding {
    const seen = new Set<string>()
    let current = storyId
    while (true) {
      requireValue(!seen.has(current) && seen.size < 1024, 'INVALID_STORY_LINEAGE', '故事的分支来源无效，无法确定工作目录。', 500)
      seen.add(current)
      const changed = current === storyId ? this.database.sqlite.prepare("SELECT data FROM events WHERE story_id = ? AND type = 'workspace.changed' ORDER BY seq DESC LIMIT 1").get(current) as { data: string } | undefined : undefined
      if (changed) return JSON.parse(changed.data) as WorkspaceBinding
      const created = this.eventsOfTypes(current, ['story.created'])[0]
      requireValue(created?.type === 'story.created', 'INVALID_STORY_LINEAGE', '故事缺少创建记录，无法确定工作目录。', 500)
      if (!created.data.forkedFrom) return { workspaceId: null, directory: current, access: 'read-write', createIfMissing: true }
      current = created.data.forkedFrom.storyId
    }
  }

  eventLog(storyId: string, after = 0): StoryEvent[] {
    this.assertExists(storyId)
    const rows = this.database.orm.select().from(events).where(and(eq(events.storyId, storyId), gt(events.seq, after))).orderBy(asc(events.seq)).all()
    return rows.map(({ idempotencyKey: _key, ...row }) => row as StoryEvent)
  }

  /** SQL excludes large model payloads before parsing the visible-story projection. */
  projectionEvents(storyId: string): StoryEvent[] {
    this.assertExists(storyId)
    return this.database.orm.select().from(events).where(and(eq(events.storyId, storyId), notInArray(events.type, DIAGNOSTIC_EVENTS))).orderBy(asc(events.seq)).all()
      .map(({ idempotencyKey: _key, ...row }) => row as StoryEvent)
  }

  /** Read only surface-producing records; provider request copies and child transcripts are diagnostics. */
  historyEvents(storyId: string): StoryEvent[] {
    this.assertExists(storyId)
    return this.database.orm.select().from(events).where(and(eq(events.storyId, storyId), or(
      inArray(events.type, ['message.added', 'turn.committed', 'message.edited', 'messages.removed', 'context.built', 'context.compacted', 'history.inherited']),
      and(eq(events.type, 'model.message'), inArray(sql`json_extract(${events.data}, '$.role')`, ['user', 'assistant', 'toolResult'])),
    ))).orderBy(asc(events.seq)).all().map(({ idempotencyKey: _key, ...row }) => row as StoryEvent)
  }

  eventsOfTypes(storyId: string, types: StoryEventInput['type'][], scope?: { field: 'runId' | 'id'; value: string }): StoryEvent[] {
    this.assertExists(storyId)
    const field = scope?.field === 'runId' ? sql`json_extract(${events.data}, '$.runId')` : sql`json_extract(${events.data}, '$.id')`
    return this.database.orm.select().from(events).where(and(eq(events.storyId, storyId), inArray(events.type, types), scope ? eq(field, scope.value) : undefined)).orderBy(asc(events.seq)).all()
      .map(({ idempotencyKey: _key, ...row }) => row as StoryEvent)
  }

  latestRunEvent(storyId: string, runId: string, type: 'context.built' | 'writer.completed'): StoryEvent | undefined {
    return this.database.orm.select().from(events).where(and(eq(events.storyId, storyId), eq(events.type, type), eq(sql`json_extract(${events.data}, '$.runId')`, runId))).orderBy(desc(events.seq)).limit(1).get() as StoryEvent | undefined
  }

  toolEvents(storyId: string, runId: string): StoryEvent[] {
    const starts = this.eventsOfTypes(storyId, ['tool.started'], { field: 'runId', value: runId })
    const ids = starts.flatMap(event => event.type === 'tool.started' ? [event.data.callId] : [])
    const updates = ids.length ? this.database.orm.select().from(events).where(and(eq(events.storyId, storyId), inArray(events.type, ['tool.updated', 'tool.finished']), inArray(sql`json_extract(${events.data}, '$.callId')`, ids))).all() : []
    return [...starts, ...updates, ...this.eventsOfTypes(storyId, ['run.status'], { field: 'runId', value: runId })].sort((a, b) => a.seq - b.seq) as StoryEvent[]
  }

  eventBatch(storyId: string, after: number, limit = 50): StoryEvent[] {
    requireValue(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'INVALID_CURSOR', '事件位置或批量大小不正确。')
    this.assertExists(storyId)
    return this.database.orm.select().from(events).where(and(eq(events.storyId, storyId), gt(events.seq, after))).orderBy(asc(events.seq)).limit(limit).all()
      .map(({ idempotencyKey: _key, ...row }) => row as StoryEvent)
  }

  latestSequence(storyId: string) {
    this.assertExists(storyId)
    return this.database.orm.select({ seq: max(events.seq) }).from(events).where(eq(events.storyId, storyId)).get()?.seq ?? 0
  }

  storyRuns(storyId: string, limit = 30, includeRunId?: string | null) {
    this.assertExists(storyId)
    requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'INVALID_LIMIT', '执行记录批量大小不正确。')
    const recent = this.database.orm.select().from(runs).where(eq(runs.storyId, storyId)).orderBy(desc(runs.createdAt), desc(runs.id)).limit(limit).all()
    if (includeRunId && !recent.some(run => run.id === includeRunId)) {
      const visible = this.database.orm.select().from(runs).where(and(eq(runs.storyId, storyId), eq(runs.id, includeRunId))).get()
      if (visible) recent.push(visible)
    }
    return recent
  }

  runPage(storyId: string, before?: string) {
    this.assertExists(storyId)
    const cursor = before ? this.run(before) : undefined
    requireValue(!cursor || cursor.storyId === storyId, 'INVALID_CURSOR', '执行记录位置不属于这段故事。')
    const rows = this.database.orm.select().from(runs).where(and(eq(runs.storyId, storyId), cursor ? or(lt(runs.createdAt, cursor.createdAt), and(eq(runs.createdAt, cursor.createdAt), lt(runs.id, cursor.id))) : undefined))
      .orderBy(desc(runs.createdAt), desc(runs.id)).limit(31).all()
    return { runs: rows.slice(0, 30), nextCursor: rows.length > 30 ? rows[29]!.id : null }
  }

  snapshot(storyId: string) {
    const snapshot = projectStory(this.projectionEvents(storyId))
    const last = this.database.orm.select({ seq: events.seq, createdAt: events.createdAt }).from(events).where(eq(events.storyId, storyId)).orderBy(desc(events.seq)).limit(1).get()!
    snapshot.revision = last.seq; snapshot.updatedAt = last.createdAt
    return snapshot
  }

  append(storyId: string, event: StoryEventInput, idempotencyKey?: string): StoryEvent {
    return this.database.transaction(() => this.appendInsideTransaction(storyId, event, idempotencyKey))
  }

  private appendInsideTransaction(storyId: string, event: StoryEventInput, idempotencyKey?: string): StoryEvent {
    const now = new Date().toISOString()
    this.assertExists(storyId)
    const row = this.database.orm.insert(events).values({
      storyId, type: event.type, data: event.data as unknown as JsonObject,
      idempotencyKey: idempotencyKey ?? null, createdAt: now,
    }).returning().get()
    this.database.orm.update(stories).set({ updatedAt: now,
      ...(event.type === 'story.renamed' ? { title: event.data.title } : {}),
      ...(event.type === 'story.archived' ? { archived: event.data.archived } : {}),
    }).where(eq(stories.id, storyId)).run()
    return { ...event, seq: row.seq, storyId, createdAt: now }
  }

  findEvent(storyId: string, idempotencyKey: string): StoryEvent | undefined {
    const row = this.database.orm.select().from(events).where(and(eq(events.storyId, storyId), eq(events.idempotencyKey, idempotencyKey))).get()
    return row as StoryEvent | undefined
  }

  mutate<T>(storyId: string, expectedRevision: number, operation: () => T): T {
    return this.database.transaction(() => {
      this.assertIdle(storyId)
      this.assertRevision(storyId, expectedRevision)
      return operation()
    })
  }

  assertRevision(storyId: string, expected: number) {
    const current = this.database.orm.select({ seq: max(events.seq) }).from(events).where(eq(events.storyId, storyId)).get()?.seq
    requireValue(current !== undefined && current !== null, 'STORY_NOT_FOUND', '这段故事已不存在。', 404)
    requireValue(current === expected, 'REVISION_CONFLICT', '故事已经更新，请刷新后再保存。', 409)
  }

  assertExists(storyId: string) {
    requireValue(this.database.orm.select({ id: stories.id }).from(stories).where(eq(stories.id, storyId)).get(), 'STORY_NOT_FOUND', '这段故事已不存在。', 404)
  }

  assertIdle(storyId: string) {
    this.assertExists(storyId)
    const active = this.database.orm.select({ id: runs.id }).from(runs).where(and(eq(runs.storyId, storyId), inArray(runs.status, PENDING))).get()
    requireValue(!active, 'STORY_BUSY', '请等待当前回复结束，或先停止生成。', 409)
    const summary = this.database.sqlite.prepare("SELECT json_extract(data, '$.status') AS status, json_extract(data, '$.trigger') AS trigger FROM events WHERE story_id = ? AND type = 'maintenance.status' AND json_extract(data, '$.kind') = 'summary' ORDER BY seq DESC LIMIT 1").get(storyId) as { status: string; trigger: string } | undefined
    requireValue(summary?.status !== 'running' || summary.trigger !== 'manual', 'SUMMARY_BUSY', '正在整理前情，请等待完成或先停止总结。', 409)
  }

  enqueue(input: { storyId: string; requestId: string; inputHash: string; turnId: string }, accepted: (run: RunRecord) => void): { run: RunRecord; duplicate: boolean } {
    return this.database.transaction(() => {
      const existing = this.database.orm.select().from(runs).where(and(eq(runs.storyId, input.storyId), eq(runs.requestId, input.requestId))).get()
      if (existing) {
        requireValue(existing.inputHash === input.inputHash, 'REQUEST_CONFLICT', '同一次发送包含了不同内容，请重新发送。', 409)
        return { run: existing, duplicate: true }
      }
      this.assertIdle(input.storyId)
      const now = new Date().toISOString()
      const run = this.database.orm.insert(runs).values({ ...input, id: randomUUID(), status: 'queued', createdAt: now, updatedAt: now }).returning().get()
      accepted(run)
      this.append(input.storyId, { type: 'run.status', data: { runId: run.id, status: 'queued' } })
      return { run, duplicate: false }
    })
  }

  run(runId: string): RunRecord {
    const run = this.database.orm.select().from(runs).where(eq(runs.id, runId)).get()
    if (!run) throw new RpError('RUN_NOT_FOUND', '这次生成记录已不存在。', 404)
    return run
  }

  hasCommitted(runId: string) {
    const run = this.run(runId)
    return !!this.database.sqlite.prepare("SELECT 1 FROM events WHERE story_id = ? AND type = 'turn.committed' AND json_extract(data, '$.runId') = ? LIMIT 1").get(run.storyId, runId)
  }

  nextQueued(): RunRecord | undefined {
    // The partial unique index keeps each story serial; other stories may run independently.
    return this.database.orm.select().from(runs).where(eq(runs.status, 'queued')).orderBy(asc(runs.createdAt), asc(runs.id)).get()
  }

  setRunStatus(runId: string, status: RunStatus, error?: { code: string; message: string }) {
    return this.database.transaction(() => {
      const run = this.run(runId)
      requireValue(TRANSITIONS[run.status].includes(status), 'RUN_STATE_CONFLICT', '这次生成已经改变状态，请刷新后查看。', 409)
      this.database.orm.update(runs).set({ status, error: error ?? null, updatedAt: new Date().toISOString() }).where(eq(runs.id, runId)).run()
      if (['failed', 'cancelled', 'interrupted'].includes(status) && run.draft.trim() && !this.hasCommitted(runId)) {
        const messages = this.snapshot(run.storyId).messages
        const visible = messages.some(message => message.runId === runId && message.kind !== 'tool')
        const assistant = messages.some(message => message.runId === runId && message.role === 'assistant' && message.kind !== 'tool')
        if (visible && !assistant) this.append(run.storyId, { type: 'message.added', data: { message: {
          id: runId, role: 'assistant', kind: 'draft', text: run.draft, runId, turnId: run.turnId,
          attachmentIds: [], createdAt: new Date().toISOString(),
        } } }, `recoverable:${runId}`)
      }
      this.append(run.storyId, { type: 'run.status', data: { runId, status, ...(error ? { error } : {}) } })
      return this.run(runId)
    })
  }

  saveDraft(runId: string, text: string) {
    return this.database.transaction(() => {
      const run = this.run(runId)
      requireValue(run.status === 'running', 'RUN_STATE_CONFLICT', '这次生成已经停止。', 409)
      if (run.draft === text) return undefined
      const replace = !text.startsWith(run.draft)
      this.database.orm.update(runs).set({ draft: text, updatedAt: new Date().toISOString() }).where(eq(runs.id, runId)).run()
      return this.append(run.storyId, { type: 'run.draft', data: { runId, text: replace ? text : text.slice(run.draft.length), replace } })
    })
  }

  recoverInterrupted(): number {
    return this.database.transaction(() => {
      const active = this.database.orm.select().from(runs).where(inArray(runs.status, ['running', 'waiting_user'])).all()
      for (const run of active) {
        if (this.hasCommitted(run.id)) this.setRunStatus(run.id, 'completed')
        else this.setRunStatus(run.id, 'interrupted', { code: 'PROCESS_INTERRUPTED', message: '服务重启中断了这次生成。草稿和已执行工具的记录仍保留，请检查后重新生成。' })
      }
      return active.length
    })
  }
}
