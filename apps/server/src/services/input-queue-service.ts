import { createHash, randomUUID } from 'node:crypto'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { FileRecord, MessageInput, PendingInput } from '../../../../packages/rp-core/src/types.ts'
import type { StoryService } from './story-service.ts'
import { validateInputFiles, validateMessageInputs } from './message-input.ts'

type Row = Omit<PendingInput, 'inputs'> & { inputs: string; requestHash: string }
const SELECT = `SELECT id, story_id AS storyId, revision, mode, target_run_id AS targetRunId,
  inputs, status, applied_run_id AS appliedRunId, created_at AS createdAt, request_hash AS requestHash FROM pending_inputs`
const decode = ({ inputs, requestHash: _hash, ...row }: Row): PendingInput => ({ ...row, inputs: JSON.parse(inputs) as MessageInput[] })

/** Pending input is durable but becomes conversation history only at an accepted run boundary. */
export class InputQueueService {
  private readonly receivers = new Map<string, { notify: () => void; validate: (files: FileRecord[]) => void }>()
  constructor(readonly service: StoryService) {}
  private get stories() { return this.service.repository }
  private get db() { return this.stories.database.sqlite }

  list(storyId: string) {
    this.stories.assertExists(storyId)
    return (this.db.prepare(`${SELECT} WHERE story_id = ? AND status = 'pending' ORDER BY position`).all(storyId) as Row[]).map(decode)
  }
  get(id: string) {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined
    requireValue(row, 'INPUT_NOT_FOUND', '这条待发消息已不存在。', 404)
    return decode(row)
  }
  submit(storyId: string, requestId: string, inputs: MessageInput[], mode: 'queue' | 'steer', targetRunId?: string) {
    requireValue(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128, 'INVALID_REQUEST', '这次发送缺少有效标识，请重试。')
    validateMessageInputs(inputs, this.service.files)
    const hash = createHash('sha256').update(JSON.stringify({ inputs, mode, targetRunId })).digest('hex')
    const result = this.stories.database.transaction(() => {
      const prior = this.db.prepare(`${SELECT} WHERE story_id = ? AND request_id = ?`).get(storyId, requestId) as Row | undefined
      if (prior) { requireValue(prior.requestHash === hash, 'REQUEST_CONFLICT', '同一次发送包含不同内容，请重新发送。', 409); return { item: decode(prior), duplicate: true } }
      requireValue(!this.stories.snapshot(storyId).archived, 'STORY_ARCHIVED', '请先恢复这段会话。', 409)
      requireValue(this.list(storyId).length < 64, 'INPUT_QUEUE_FULL', '这段会话最多保留 64 条待发消息。')
      this.validateTarget(storyId, mode, targetRunId, inputs)
      const item: PendingInput = { id: randomUUID(), storyId, revision: 1, mode, targetRunId: mode === 'steer' ? targetRunId! : null, inputs: structuredClone(inputs), status: 'pending', appliedRunId: null, createdAt: new Date().toISOString() }
      const event = this.stories.append(storyId, { type: 'input.queued', data: { item } })
      this.db.prepare(`INSERT INTO pending_inputs (id, story_id, request_id, request_hash, revision, mode, target_run_id, inputs, status, applied_run_id, created_at, position) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'pending', NULL, ?, ?)`).run(item.id, storyId, requestId, hash, mode, item.targetRunId, JSON.stringify(inputs), item.createdAt, event.seq)
      return { item, duplicate: false }
    })
    if (result.item.mode === 'steer' && result.item.status === 'pending') this.receivers.get(result.item.targetRunId!)?.notify()
    return result
  }

  update(storyId: string, id: string, revision: number, inputs: MessageInput[], mode: 'queue' | 'steer', targetRunId?: string) {
    validateMessageInputs(inputs, this.service.files)
    const result = this.stories.database.transaction(() => {
      this.editable(storyId, id, revision)
      this.validateTarget(storyId, mode, targetRunId, inputs, id)
      this.db.prepare('UPDATE pending_inputs SET inputs = ?, mode = ?, target_run_id = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(inputs), mode, mode === 'steer' ? targetRunId! : null, id)
      this.stories.append(storyId, { type: 'input.changed', data: { id, revision: revision + 1, inputs, mode, targetRunId: mode === 'steer' ? targetRunId! : null } })
      return this.get(id)
    })
    if (mode === 'steer') this.receivers.get(targetRunId!)?.notify()
    return result
  }
  remove(storyId: string, id: string, revision: number) {
    return this.stories.database.transaction(() => { this.editable(storyId, id, revision); return this.resolve(id, 'cancelled') })
  }
  steerAll(storyId: string, targetRunId: string, selections: { id: string; revision: number }[]) {
    requireValue(selections.length > 0 && selections.length <= 64 && new Set(selections.map(item => item.id)).size === selections.length, 'INVALID_REQUEST', '请选择需要干预的待发消息。')
    this.stories.database.transaction(() => {
      const items = selections.map(item => this.editable(storyId, item.id, item.revision))
      this.validateTarget(storyId, 'steer', targetRunId, items.flatMap(item => item.inputs))
      for (const item of items) {
        this.db.prepare("UPDATE pending_inputs SET mode = 'steer', target_run_id = ?, revision = revision + 1 WHERE id = ?").run(targetRunId, item.id)
        this.stories.append(storyId, { type: 'input.changed', data: { id: item.id, revision: item.revision + 1, inputs: item.inputs, mode: 'steer', targetRunId } })
      }
    })
    this.receivers.get(targetRunId)?.notify()
    return this.list(storyId)
  }

  register(runId: string, receiver: { notify: () => void; validate: (files: FileRecord[]) => void }) {
    this.receivers.set(runId, receiver)
    return () => { if (this.receivers.get(runId) === receiver) this.receivers.delete(runId) }
  }
  hasSteering(runId: string) {
    return !!this.db.prepare("SELECT 1 FROM pending_inputs WHERE target_run_id = ? AND mode = 'steer' AND status = 'pending' LIMIT 1").get(runId)
  }
  consumeSteering(runId: string) {
    return this.stories.database.transaction(() => {
      const run = this.stories.run(runId)
      requireValue(run.status === 'running' && !this.stories.hasCommitted(runId), 'RUN_STATE_CONFLICT', '本轮已经结束，不能再干预。', 409)
      const items = this.list(run.storyId).filter(item => item.mode === 'steer' && item.targetRunId === runId)
      for (const item of items) {
        for (const input of item.inputs) this.stories.append(run.storyId, { type: 'message.added', data: { message: {
          id: randomUUID(), role: 'user', kind: 'message', ...input, turnId: run.turnId, runId, createdAt: new Date().toISOString(),
        } } })
        this.resolve(item.id, 'applied', runId)
      }
      return items.length > 0
    })
  }

  /** Promote one FIFO entry atomically; the active turn can never see later queued inputs. */
  promote() {
    return this.stories.database.transaction(() => {
      const row = this.db.prepare(`${SELECT} WHERE status = 'pending' AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.story_id = pending_inputs.story_id AND runs.status IN ('queued','running','waiting_user')) AND NOT EXISTS (SELECT 1 FROM stories WHERE stories.id = pending_inputs.story_id AND stories.archived = 1)
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.seq = (SELECT max(s.seq) FROM events s WHERE s.story_id = pending_inputs.story_id AND s.type = 'maintenance.status' AND json_extract(s.data, '$.kind') = 'summary') AND json_extract(e.data, '$.status') = 'running' AND json_extract(e.data, '$.trigger') = 'manual')
        ORDER BY position LIMIT 1`).get() as Row | undefined
      if (!row) return false
      const item = decode(row)
      const { run } = this.service.send(item.storyId, `pending:${item.id}`, item.inputs)
      this.resolve(item.id, 'applied', run.id)
      return true
    })
  }

  private validateTarget(storyId: string, mode: string, targetRunId: string | undefined, inputs: MessageInput[], exclude?: string) {
    requireValue(mode === 'queue' || mode === 'steer', 'INVALID_REQUEST', '发送方式不正确。')
    if (mode === 'queue') return
    requireValue(targetRunId, 'RUN_STATE_CONFLICT', '请先选择正在生成的轮次。', 409)
    const run = this.stories.run(targetRunId), receiver = this.receivers.get(targetRunId)
    requireValue(run.storyId === storyId && ['running', 'waiting_user'].includes(run.status) && !this.stories.hasCommitted(run.id), 'RUN_STATE_CONFLICT', '本轮已经结束，输入已保留，请加入待发消息。', 409)
    requireValue(receiver, 'RUN_STARTING', '本轮正在准备，请稍后干预或加入待发消息。', 409)
    const previous = this.stories.snapshot(storyId).messages.filter(message => message.runId === run.id && message.role === 'user')
    const pending = this.list(storyId).filter(item => item.mode === 'steer' && item.targetRunId === run.id && item.id !== exclude).flatMap(item => item.inputs)
    const files = validateInputFiles([...previous, ...pending, ...inputs].flatMap(input => input.attachmentIds), this.service.files)
    receiver.validate(files)
  }
  private editable(storyId: string, id: string, revision: number) {
    const item = this.get(id)
    requireValue(item.storyId === storyId, 'INPUT_NOT_FOUND', '这条待发消息不属于当前会话。', 404)
    requireValue(item.status === 'pending', 'INPUT_ALREADY_APPLIED', '这条消息已经开始处理，请刷新查看。', 409)
    requireValue(item.revision === revision, 'REVISION_CONFLICT', '待发消息已更新，请刷新后重试。', 409)
    return item
  }
  private resolve(id: string, status: 'applied' | 'cancelled', runId?: string) {
    const item = this.get(id)
    this.db.prepare('UPDATE pending_inputs SET status = ?, applied_run_id = ?, revision = revision + 1 WHERE id = ?').run(status, runId ?? null, id)
    this.stories.append(item.storyId, { type: 'input.resolved', data: { id, status, ...(runId ? { runId } : {}) } })
    return this.get(id)
  }
}
