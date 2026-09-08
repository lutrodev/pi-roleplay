import { Type } from '@earendil-works/pi-ai'
import { addAssetBinding, BINDING_KINDS, boundAssetIds, GUIDE_NAMES, normalizeBindingChanges } from '../../../../packages/rp-core/src/assets/bindings.ts'
import { modelReadableAsset, prepareModelAsset } from '../../../../packages/rp-core/src/assets/model-input.ts'
import { objectInput } from '../../../../packages/rp-core/src/input.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { ASSET_KINDS, type AssetKind, type AssetRecord, type JsonObject, type JsonValue, type RunRecord } from '../../../../packages/rp-core/src/types.ts'
import type { FileService } from '../services/file-service.ts'
import type { StoryService } from '../services/story-service.ts'
import type { TurnService } from '../services/turn-service.ts'
import type { RuntimeToolScope } from './executor.ts'
import type { SkillSession } from './skills.ts'
import type { ToolClient } from './tool-client.ts'
import { defineTool, toolResult } from './tool-result.ts'

const kindSchema = Type.Unsafe<AssetKind>({ type: 'string', enum: [...ASSET_KINDS] })
const idSchema = Type.String({ minLength: 1, maxLength: 128 })
const objectSchema = Type.Record(Type.String(), Type.Unknown())
const strict = { additionalProperties: false }

/** One instance per main run: failed requested changes prevent narrative work until a successful correction. */
export class RoleplayTools {
  private unfinishedChange = false
  constructor(readonly stories: StoryService, readonly turns: TurnService, readonly files: FileService, readonly client: ToolClient,
    readonly skills?: SkillSession, readonly stateEnabled = true) {}

  assertReady() { requireValue(!this.unfinishedChange, 'RP_CHANGE_INCOMPLETE', '请求的资料或变量修改尚未完成。请先解决工具错误，不能按未生效的修改继续剧情。', 409) }

  read(run: RunRecord) {
    return [defineTool({ name: 'rp_asset_read', label: '读取 RP 资料', description: 'Read RP materials without changing them. Chat may only list/get assets bound to the current story; Agent may inspect the whole shared library. Use exact returned IDs and revisions for subsequent mutations.',
      parameters: Type.Union([
        Type.Object({ action: Type.Literal('list'), kind: kindSchema, query: Type.Optional(Type.String({ maxLength: 200 })), cursor: Type.Optional(Type.String({ pattern: '^(0|[1-9][0-9]*)$' })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, strict),
        Type.Object({ action: Type.Literal('get'), kind: kindSchema, id: idSchema }, strict),
      ]),
      execute: async (_callId, input, signal) => toolResult(async () => {
        signal?.throwIfAborted()
        this.requireKind(input.kind)
        const profile = this.stories.repository.snapshot(run.storyId).profile
        const library = profile.runtime.executionMode === 'agent', scope = library ? 'library' : 'current_session'
        const ids = boundAssetIds(profile, input.kind)
        if (input.action === 'get') {
          requireValue(library || ids.includes(input.id), 'RP_ASSET_NOT_BOUND', 'Chat 模式只可读取当前故事绑定的资料。', 403)
          return json({ action: input.action, kind: input.kind, scope, asset: modelReadableAsset(this.stories.assets.get(input.id, input.kind)) })
        }
        const query = input.query?.trim().toLocaleLowerCase() ?? '', offset = Number(input.cursor ?? 0), limit = input.limit ?? 50
        requireValue(Number.isSafeInteger(offset) && offset >= 0, 'INVALID_CURSOR', '资料列表位置不正确。')
        const rows = library ? this.stories.assets.list(input.kind).map(summary)
          : ids.map(id => { const asset = this.stories.assets.resolve(id, input.kind); return asset ? summary(asset) : { id, status: 'missing', name: '' } })
        const matched = rows.filter(item => !query || `${item.name} ${item.id}`.toLocaleLowerCase().includes(query))
        const items = matched.slice(offset, offset + limit)
        return json({ action: input.action, kind: input.kind, scope, page: { items, total: matched.length, nextCursor: offset + items.length < matched.length ? String(offset + items.length) : null } })
      }),
    }), ...(this.stateEnabled ? [defineTool({ name: 'rp_state_read', label: '读取故事变量', description: 'Read the current story-owned state. list returns namespace summaries; get returns the full definition, initial/current values, namespace revision, rules and diagnostics. Variables use the exact namespace ID and JSON Pointer.',
      parameters: Type.Union([Type.Object({ action: Type.Literal('list') }, strict), Type.Object({ action: Type.Literal('get'), namespace: idSchema }, strict)]),
      execute: async (_callId, input, signal) => toolResult(async () => {
        signal?.throwIfAborted()
        const story = this.stories.repository.snapshot(run.storyId)
        if (input.action === 'get') {
          const snapshot = Object.hasOwn(story.state.namespaces, input.namespace) ? story.state.namespaces[input.namespace] : undefined
          requireValue(snapshot, 'STATE_NOT_FOUND', '这个变量组已不存在。', 404)
          return json({ protocolVersion: 2, namespace: input.namespace, ...snapshot })
        }
        return json({ protocolVersion: 2, revision: story.revision, namespaces: Object.entries(story.state.namespaces).map(([namespace, snapshot]) => ({ namespace, title: snapshot.definition.title, revision: snapshot.revision, updateMode: snapshot.definition.updateMode })) })
      }),
    })] : [])]
  }

  agent(scope: RuntimeToolScope) {
    this.assertAgent(scope)
    return [...this.read(scope.run), defineTool({ name: 'rp_asset', label: '修改 RP 资料', description: 'Agent only; use after an explicit user request. Before any action, including bind-only changes, load every affected asset kind\'s RP guide with skill in the current Run; guides loaded in earlier Runs do not carry over. create saves a native asset, optionally binding it here; update uses the exact revision and canonical editable body (character/lorebook accept patches); bind changes only specified bindings, replacing ordered lists. A successful asset write may survive a failed bind or context refresh: inspect ok and phases, and never repeat a successful create.',
      parameters: Type.Union([
        Type.Object({ action: Type.Literal('create'), kind: kindSchema, value: objectSchema, bindToCurrentSession: Type.Optional(Type.Boolean()) }, strict),
        Type.Object({ action: Type.Literal('update'), kind: kindSchema, id: idSchema, expectedRevision: Type.Integer({ minimum: 1 }), value: objectSchema }, strict),
        Type.Object({ action: Type.Literal('bind'), changes: Type.Object({ cardId: Type.Optional(Type.Union([idSchema, Type.Null()])), personaId: Type.Optional(Type.Union([idSchema, Type.Null()])), presetId: Type.Optional(Type.Union([idSchema, Type.Null()])), lorebookIds: Type.Optional(Type.Array(idSchema, { maxItems: 128 })), writingStyleIds: Type.Optional(Type.Array(idSchema, { maxItems: 16 })) }, { ...strict, minProperties: 1 }) }, strict),
      ]),
      execute: async (_callId, input, signal) => this.mutation(async () => {
        signal?.throwIfAborted(); this.assertAgent(scope)
        if (input.action === 'bind') {
          const changes = normalizeBindingChanges(input.changes)
          for (const key of Object.keys(changes)) { const kind = BINDING_KINDS[key as keyof typeof BINDING_KINDS]; this.requireKind(kind); this.requireGuide(GUIDE_NAMES[kind]) }
          const profile = this.stories.bindDuringRun(scope.run.id, changes)
          return this.refresh(scope, json({ action: 'bind', ok: true, bindings: profile.resources, phases: { binding: { status: 'succeeded', durable: true } } }) as JsonObject)
        }
        this.requireKind(input.kind); this.requireGuide(GUIDE_NAMES[input.kind])
        const current = input.action === 'update' ? this.stories.assets.get(input.id, input.kind) : undefined
        const value = prepareModelAsset(input.kind, input.value, current)
        if (input.kind === 'lorebook') this.checkStateConditions(value, current)
        const asset = input.action === 'create' ? this.stories.assets.create(input.kind, value) : this.stories.assets.update(input.id, input.expectedRevision, value)
        const phases: JsonObject = { assetWrite: { status: 'succeeded', durable: true, id: asset.id, revision: asset.revision }, binding: { status: 'not-requested', durable: false } }
        let ok = true
        if (input.action === 'create' && input.bindToCurrentSession) {
          try {
            const profile = this.stories.repository.snapshot(scope.run.storyId).profile
            this.stories.bindDuringRun(scope.run.id, addAssetBinding(profile, input.kind, asset.id))
            phases.binding = { status: 'succeeded', durable: true }
          } catch (error) { ok = false; phases.binding = { status: 'failed', durable: false, error: publicError(error) } }
        }
        return this.refresh(scope, { action: input.action, ok, asset: modelReadableAsset(asset), phases })
      }),
    }), ...(this.stateEnabled ? [this.stateTool(scope)] : []), ...(['character', 'lorebook'] as const).map(kind => this.importTool(scope, kind))]
  }

  private stateTool(scope: RuntimeToolScope) {
    const definition = Type.Object({ title: Type.String({ minLength: 1 }), description: Type.Optional(Type.String()), updateMode: Type.Union([Type.Literal('schema-only'), Type.Literal('rules-required'), Type.Literal('disabled')]), schema: objectSchema, rules: Type.Array(objectSchema, { maxItems: 1024 }) }, strict)
    return defineTool({ name: 'rp_state', label: '配置故事变量', description: 'Agent only after an explicit request to change saved state and loading rp-guide-state. Read the latest revision first. create requires expectedRevision:0, full definition and initialValue. update replaces the complete definition and optionally complete initialValue/value. reset/delete affect the entire namespace. Ordinary narrative value changes belong in rp_commit_turn effects.',
      parameters: Type.Union([
        Type.Object({ action: Type.Literal('create'), namespace: idSchema, expectedRevision: Type.Literal(0), definition, initialValue: Type.Unknown() }, strict),
        Type.Object({ action: Type.Literal('update'), namespace: idSchema, expectedRevision: Type.Integer({ minimum: 1 }), definition, initialValue: Type.Optional(Type.Unknown()), value: Type.Optional(Type.Unknown()) }, strict),
        Type.Object({ action: Type.Union([Type.Literal('reset'), Type.Literal('delete')]), namespace: idSchema, expectedRevision: Type.Integer({ minimum: 1 }) }, strict),
      ]),
      execute: async (_callId, input, signal) => this.mutation(async () => {
        signal?.throwIfAborted(); this.assertAgent(scope); this.requireGuide('rp-guide-state')
        const { action, ...values } = input
        const event = this.turns.configureState(scope.run.id, scope.owner(), { ...values, operation: action })
        return this.refresh(scope, json({ action, ok: true, update: event.type === 'state.configured' ? event.data.update : null, phases: { stateWrite: { status: 'succeeded', durable: true } } }) as JsonObject)
      }),
    })
  }

  private importTool(scope: RuntimeToolScope, kind: 'character' | 'lorebook') {
    return defineTool({ name: kind === 'character' ? 'import_character_card' : 'import_lore_book', label: kind === 'character' ? '导入角色卡' : '导入世界书', description: 'Import an explicitly requested file from an attachment or the story workspace. Character cards support PNG/JSON; world books support JSON. Load the matching RP guide first. Import creates shared material and never binds it automatically. Do not retry successful imports; inspect a duplicate error for the existing ID.',
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }) }, strict),
      execute: async (_callId, input, signal) => this.mutation(async () => {
        this.assertAgent(scope); this.requireGuide(GUIDE_NAMES[kind])
        const effectiveSignal = signal ? AbortSignal.any([scope.signal, signal]) : scope.signal
        const payload = await this.client.execute(scope.run.storyId, { kind: 'download', path: input.path }, { signal: effectiveSignal })
        objectInput(payload)
        requireValue(typeof payload.base64 === 'string' && typeof payload.name === 'string', 'TOOL_PROTOCOL_ERROR', '工具服务返回了不正确的文件数据。', 502)
        const bytes = Buffer.from(payload.base64, 'base64')
        effectiveSignal.throwIfAborted(); this.assertAgent(scope)
        if (kind === 'character') {
          const imported = await this.files.importCharacter(bytes, payload.name)
          return this.refresh(scope, { action: 'import', ok: true, asset: modelReadableAsset(imported.card), lorebook: imported.lorebook ? modelReadableAsset(imported.lorebook) : null, phases: { assetWrite: { status: 'succeeded', durable: true }, binding: { status: 'not-requested', durable: false } } })
        }
        const asset = this.files.importLorebook(bytes)
        return this.refresh(scope, { action: 'import', ok: true, asset: modelReadableAsset(asset), phases: { assetWrite: { status: 'succeeded', durable: true }, binding: { status: 'not-requested', durable: false } } })
      }),
    })
  }

  private checkStateConditions(value: JsonObject, current?: AssetRecord) {
    const previous = new Map((Array.isArray(current?.data.entries) ? current.data.entries : []).map(entry => { objectInput(entry); return [entry.id, entry.stateCondition] }))
    for (const entry of Array.isArray(value.entries) ? value.entries : []) {
      objectInput(entry)
      if (typeof entry.stateCondition === 'string' && entry.stateCondition !== previous.get(entry.id)) {
        requireValue(this.stateEnabled, 'STATE_UNAVAILABLE', '请先在本会话的变量页启用会话变量，再配置世界书的变量条件。')
        this.requireGuide('rp-guide-state')
      }
    }
  }

  private assertAgent(scope: RuntimeToolScope) {
    scope.signal.throwIfAborted()
    requireValue(this.stories.repository.run(scope.run.id).status === 'running', 'RUN_STATE_CONFLICT', '当前生成已停止。', 409)
    requireValue(this.stories.repository.snapshot(scope.run.storyId).profile.runtime.executionMode === 'agent', 'TOOL_NOT_ALLOWED', '请切换到 Agent 模式后修改资料。', 403)
  }
  private requireGuide(name: string) { requireValue(this.skills, 'SKILL_UNAVAILABLE', '本轮未启用资料指导 Skills，无法执行这类修改。'); this.skills.require(name) }
  private requireKind(kind: AssetKind) { requireValue(ASSET_KINDS.includes(kind), 'INVALID_ASSET_KIND', '资料类型不正确。') }
  private refresh(scope: RuntimeToolScope, result: JsonObject) {
    const phases = result.phases as JsonObject
    try { scope.refreshContext(); phases.contextRefresh = { status: 'succeeded', durable: false } }
    catch (error) { result.ok = false; phases.contextRefresh = { status: 'failed', durable: false, error: publicError(error) } }
    return result
  }
  private mutation(operation: () => Promise<JsonObject>) {
    return toolResult(async () => {
      try { const result = await operation(); this.unfinishedChange = result.ok === false; return result }
      catch (error) { this.unfinishedChange = true; throw error }
    })
  }
}

function summary(asset: AssetRecord) { return { id: asset.id, name: asset.name, revision: asset.revision, status: 'ready' } }
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) }
function publicError(error: unknown): JsonObject { return error instanceof RpError ? { code: error.code, message: error.message } : { code: 'RP_OPERATION_FAILED', message: '操作未完成，请查看服务状态和工具记录。' } }
