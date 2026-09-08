import { storyVariables } from '../../../../packages/rp-core/src/story/variables.ts'
import { createHash, randomUUID } from 'node:crypto'
import { objectInput } from '../../../../packages/rp-core/src/input.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { applyCommitPatches, MAX_COMMIT_RETRY_PATCHES } from '../../../../packages/rp-core/src/story/commit-retry.js'
import { prepareStateEffects } from '../../../../packages/rp-core/src/story/effects.ts'
import { commitIssues, rejectCommitIssues, type CommitIssue } from '../../../../packages/rp-core/src/story/commit-issues.ts'
import { createNamespaceSnapshot, normalizeNamespaceId, normalizeStateDefinition } from '../../../../packages/rp-core/src/state/definition.js'
import { validateStateValue } from '../../../../packages/rp-core/src/state/schema.js'
import { requireStateNamespaceCapacity } from '../../../../packages/rp-core/src/state/limits.ts'
import type { JsonObject, JsonValue, NamespaceSnapshot, StoryEvent, StoryMessage } from '../../../../packages/rp-core/src/types.ts'
import { normalizeReplyOptionsInput, REPLY_OPTIONS_EXTENSION_NAMESPACE } from '../../../../packages/rp-core/src/interaction/reply-options.js'
import type { Preferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import type { StoryRepository } from '../storage/story-repository.ts'

interface CachedCommit { token: string; contextSeq: number; draft: JsonObject; narrative: string; ownerId: string }
const MAX_COMMIT_BYTES = 262_144

export class TurnService {
  private readonly retries = new Map<string, CachedCommit>()
  constructor(readonly stories: StoryRepository) {}

  recordWriter(runId: string, callId: string, contextSeq: number, text: string, writerHistory?: import('../../../../packages/rp-core/src/agents/writer-history.ts').WriterHistoryMetadata) {
    return this.stories.database.transaction(() => {
      const run = this.stories.run(runId)
      requireValue(run.status === 'running', 'RUN_STATE_CONFLICT', '当前生成已停止。', 409)
      requireValue(text.trim().length > 0 && [...text].length <= 200_000, 'WRITER_OUTPUT_INVALID', '写作结果为空或超过长度限制。')
      requireValue(!this.stories.findEvent(run.storyId, `writer:${runId}:${contextSeq}`), 'WRITER_ALREADY_COMPLETED', '本次写作已经完成，请直接提交正文。', 409)
      const context = this.context(run.storyId, runId)
      requireValue(context?.seq === contextSeq, 'WRITER_CONTEXT_CHANGED', '写作资料已经变化，请重新准备正文。', 409)
      return this.stories.append(run.storyId, { type: 'writer.completed', data: { runId, callId, contextSeq, text, ...(writerHistory ? { writerHistory } : {}) } }, `writer:${runId}:${contextSeq}`)
    })
  }

  async commit(runId: string, ownerId: string, narrative: string, input: unknown, stateEnabled = true, guard?: () => void, replyOptions?: Preferences['replyOptions']) {
    const run = this.stories.run(runId)
    const context = this.context(run.storyId, runId)
    requireValue(context, 'CONTEXT_REQUIRED', '本轮写作资料尚未准备完成。', 409)
    objectInput(input)
    let draft = structuredClone(input)
    if ('retry' in draft) {
      const cached = this.retries.get(runId)
      objectInput(draft.retry)
      requireValue(Object.keys(draft).length === 1 && cached && draft.retry.token === cached.token, 'COMMIT_RETRY_INVALID', '这次修正已失效，请重新检查提交结果。', 409)
      requireValue(cached.contextSeq === context.seq, 'COMMIT_RETRY_STALE', '资料已经变化，旧的提交修正不能继续使用。', 409)
      requireValue(Array.isArray(draft.retry.patches) && draft.retry.patches.length <= MAX_COMMIT_RETRY_PATCHES, 'COMMIT_RETRY_INVALID', '提交修正包含过多修改项。')
      draft = applyCommitPatches(cached.draft, draft.retry.patches) as JsonObject
      narrative = cached.narrative
      ownerId = cached.ownerId
    }
    try {
      return this.stories.database.transaction(() => {
        const writer = this.stories.latestRunEvent(run.storyId, runId, 'writer.completed')
        requireValue(writer?.type === 'writer.completed' && writer.data.contextSeq === context.seq, 'WRITER_REQUIRED', '请先完成使用当前资料的正文写作。', 409)
        const snapshot = this.stories.snapshot(run.storyId)
        stateEnabled = stateEnabled && storyVariables(snapshot.profile).enabled
        const text = snapshot.profile.runtime.executionMode === 'chat' ? writer.data.text : narrative
        requireValue(typeof text === 'string' && text.trim().length > 0 && [...text].length <= 200_000, 'NARRATIVE_INVALID', '正文为空或超过长度限制。')
        const issues: CommitIssue[] = []
        const inspect = (path: string, check: () => void) => { try { check() } catch (error) { issues.push(...commitIssues(error, path)) } }
        for (const key of Object.keys(draft)) if (!['runSummary', 'effects', 'references', 'extensions'].includes(key)) {
          issues.push({ code: 'INVALID_COMMIT', path: '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'), message: '剧情提交包含不支持的字段。' })
        }
        const summary = draft.runSummary === undefined ? [...text].slice(0, 500).join('') : draft.runSummary
        inspect('/runSummary', () => requireValue(typeof summary === 'string' && [...summary].length <= 10_000, 'SUMMARY_INVALID', '剧情摘要格式不正确或过长。'))
        const effects = draft.effects ?? []
        inspect('/effects', () => requireValue(stateEnabled || Array.isArray(effects) && effects.length === 0, 'STATE_UNAVAILABLE', '本轮未启用变量维护，不能提交变量变化。'))
        const references = draft.references ?? []
        const extensions = draft.extensions && typeof draft.extensions === 'object' && !Array.isArray(draft.extensions) ? draft.extensions : {}
        inspect('/extensions', () => requireValue(Object.keys(extensions).every(key => key === REPLY_OPTIONS_EXTENSION_NAMESPACE), 'EXTENSION_UNAVAILABLE', '本次提交包含未启用的扩展结果。'))
        issues.push(...this.validateReferences(references, context.data.sources))
        if (guard) inspect('/guard', guard)
        // Advisory options do not consume the core budget or change an already committed turn.
        const serialized = JSON.stringify({ text, summary, effects, references, extensions: {} })
        inspect('', () => requireValue(Buffer.byteLength(serialized, 'utf8') <= MAX_COMMIT_BYTES, 'COMMIT_TOO_LARGE', '本次剧情提交过大，请缩短正文或提交内容。'))
        const fingerprint = createHash('sha256').update(serialized).digest('hex')
        const existing = this.stories.findEvent(run.storyId, `commit:${runId}`)
        if (existing?.type === 'turn.committed') {
          rejectCommitIssues(issues)
          requireValue(existing.data.fingerprint === fingerprint, 'COMMIT_CONFLICT', '这次生成已经提交了不同的正文。', 409)
          return existing
        }
        inspect('/guard', () => requireValue(this.stories.run(runId).status === 'running', 'RUN_STATE_CONFLICT', '当前生成已停止，正文尚未提交。', 409))
        let prepared: Pick<ReturnType<typeof prepareStateEffects>, 'effects' | 'updates'> = { effects: [], updates: [] }
        if (stateEnabled) {
          try { prepared = prepareStateEffects(snapshot.state, effects) }
          catch (error) { issues.push(...commitIssues(error, Array.isArray(effects) ? '' : '/effects')) }
        }
        const message: StoryMessage = {
          id: ownerId, role: 'assistant', kind: 'narrative', text,
          attachmentIds: [], runId, turnId: run.turnId, createdAt: new Date().toISOString(),
        }
        const existingMessage = snapshot.messages.find(item => item.id === ownerId)
        inspect('/guard', () => requireValue(!existingMessage || (existingMessage.role === 'assistant' && existingMessage.runId === runId), 'COMMIT_OWNER_INVALID', '正文不能覆盖其他消息。', 409))
        rejectCommitIssues(issues)
        const data: Extract<StoryEvent, { type: 'turn.committed' }>['data'] = {
          commitId: runId, fingerprint, runId, message, summary: summary as string,
          effects: prepared.effects as unknown as JsonObject[], stateUpdates: prepared.updates,
          references: references as JsonValue[], extensions: {},
        }
        requireValue(commitBytes(data) <= MAX_COMMIT_BYTES, 'COMMIT_TOO_LARGE', '本次剧情提交过大，请缩短正文或提交内容。')
        if (replyOptions) {
          try {
            data.extensions[REPLY_OPTIONS_EXTENSION_NAMESPACE] = normalizeReplyOptionsInput((extensions as JsonObject)[REPLY_OPTIONS_EXTENSION_NAMESPACE], replyOptions.count)
            if (commitBytes(data) > MAX_COMMIT_BYTES) {
              delete data.extensions[REPLY_OPTIONS_EXTENSION_NAMESPACE]
              data.diagnostics = [{ source: REPLY_OPTIONS_EXTENSION_NAMESPACE, code: 'RP_GENERATED_ARTIFACT_LIMIT', severity: 'warning', message: '回复选项超过本轮容量限制，正文与状态仍正常保存。' }]
            }
          } catch {
            data.diagnostics = [{ source: REPLY_OPTIONS_EXTENSION_NAMESPACE, code: 'RP_REPLY_OPTIONS_INVALID', severity: 'warning', message: '主模型未提供可用的回复建议，正文与变量已保存。' }]
          }
        }
        const event = this.stories.append(run.storyId, { type: 'turn.committed', data }, `commit:${runId}`)
        this.retries.delete(runId)
        return event
      })
    } catch (error) {
      const token = randomUUID()
      this.retries.set(runId, { token, contextSeq: context.seq, draft, narrative, ownerId })
      const failure = error instanceof RpError ? error : new RpError('COMMIT_FAILED', '剧情尚未提交，请检查后重试。', 400)
      throw new RpError(failure.code, failure.message, failure.statusCode, { issues: failure.details, retry: { token, patches: [] } })
    }
  }

  configureState(runId: string, ownerId: string, input: { operation: 'create' | 'update' | 'reset' | 'delete'; namespace: string; expectedRevision: number; definition?: unknown; initialValue?: unknown; value?: unknown }) {
    return this.stories.database.transaction(() => {
      const run = this.stories.run(runId)
      requireValue(run.status === 'running', 'RUN_STATE_CONFLICT', '当前生成已停止。', 409)
      const snapshot = this.stories.snapshot(run.storyId)
      requireValue(snapshot.profile.runtime.executionMode === 'agent', 'TOOL_NOT_ALLOWED', '请切换到 Agent 模式后修改变量配置。', 403)
      requireValue(snapshot.messages.some(message => message.id === ownerId && message.role === 'assistant' && message.runId === runId), 'STATE_OWNER_REQUIRED', '变量配置缺少对应的工具调用消息。', 409)
      requireValue(['create', 'update', 'reset', 'delete'].includes(input.operation), 'INVALID_STATE_OPERATION', '变量配置操作不正确。')
      requireValue(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, 'STATE_REVISION_CONFLICT', '请提供最新的变量版本；创建时使用 0。', 409)
      const allowed = ['operation', 'namespace', 'expectedRevision', ...(input.operation === 'create' ? ['definition', 'initialValue'] : input.operation === 'update' ? ['definition', 'initialValue', 'value'] : [])]
      requireValue(Object.keys(input).every(key => allowed.includes(key)), 'INVALID_STATE_OPERATION', '变量配置包含不适用于当前操作的字段。')
      if (input.operation === 'create' || input.operation === 'update') requireValue(input.definition !== undefined, 'STATE_DEFINITION_REQUIRED', '请提供完整的变量定义。')
      const namespace = normalizeNamespaceId(input.namespace)
      const current = snapshot.state.namespaces[namespace]
      let next: NamespaceSnapshot | null
      if (input.operation === 'create') {
        requireValue(input.expectedRevision === 0, 'STATE_REVISION_CONFLICT', '创建变量组时版本必须为 0。', 409)
        requireValue(!current, 'STATE_EXISTS', '这个变量组已经存在。', 409)
        requireStateNamespaceCapacity(Object.keys(snapshot.state.namespaces).length + 1)
        next = createNamespaceSnapshot({ initialValue: input.initialValue, definition: normalizeStateDefinition(input.definition) })
      } else {
        requireValue(current, 'STATE_NOT_FOUND', '这个变量组已不存在。', 404)
        requireValue(current.revision === input.expectedRevision, 'STATE_REVISION_CONFLICT', '变量已经变化，请重新读取。', 409)
        if (input.operation === 'delete') next = null
        else if (input.operation === 'reset') next = { ...structuredClone(current), revision: current.revision + 1, value: structuredClone(current.initialValue), diagnostics: { ...current.diagnostics, lastCommit: [] } }
        else {
          const definition = normalizeStateDefinition(input.definition)
          const initialValue = input.initialValue === undefined ? current.initialValue : input.initialValue
          const value = input.value === undefined ? current.value : input.value
          validateStateValue(definition.schema, initialValue)
          validateStateValue(definition.schema, value)
          next = { ...createNamespaceSnapshot({ definition, initialValue, value }), revision: current.revision + 1 }
        }
      }
      this.retries.delete(runId)
      return this.stories.append(run.storyId, { type: 'state.configured', data: { ownerMessageId: ownerId, update: { namespace, snapshot: next } } })
    })
  }

  dispose(runId: string) { this.retries.delete(runId) }

  private context(storyId: string, runId: string) {
    const journal = this.stories.eventsOfTypes(storyId, ['state.configured'])
    const event = this.stories.latestRunEvent(storyId, runId, 'context.built')
    if (event && journal.some(item => item.seq > event.seq && item.type === 'state.configured')) {
      throw new RpError('CONTEXT_STALE', '变量配置已经变化，请重新准备写作资料。', 409)
    }
    return event?.type === 'context.built' ? event : undefined
  }

  private validateReferences(input: unknown, sources: JsonValue[]): CommitIssue[] {
    if (!Array.isArray(input) || input.length > 128) return [{ code: 'REFERENCE_INVALID', path: '/references', message: '引用列表格式不正确。' }]
    const issues: CommitIssue[] = []
    for (const [index, reference] of input.entries()) {
      const add = (path: string, message: string) => issues.push({ code: 'REFERENCE_INVALID', path: `/references/${index}${path}`, message })
      if (!reference || typeof reference !== 'object' || Array.isArray(reference)) { add('', '引用需要资料标识与版本。'); continue }
      if (typeof reference.id !== 'string' || !reference.id.trim()) add('/id', '引用缺少资料标识。')
      for (const key of Object.keys(reference)) if (!['source', 'id', 'revision'].includes(key)) add('/' + key.replaceAll('~', '~0').replaceAll('/', '~1'), '引用包含未知字段。')
      const source = sources.find(item => item && typeof item === 'object' && !Array.isArray(item) && item.id === reference.source)
      if (!source || typeof source !== 'object' || Array.isArray(source)) add('/source', '引用的资料不在本轮写作上下文中。')
      else if (source.revision !== reference.revision) add('/revision', '引用的资料版本不在本轮写作上下文中。')
    }
    return issues
  }
}

// Bound the authored payload; the one fixed-size diagnostic remains observable even at the payload limit.
function commitBytes(data: Extract<StoryEvent, { type: 'turn.committed' }>['data']) {
  return Buffer.byteLength(JSON.stringify({ text: data.message.text, summary: data.summary, effects: data.effects, references: data.references, extensions: data.extensions }), 'utf8')
}
