import { createHash, randomUUID } from 'node:crypto'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { applyBindingChanges, BINDING_KINDS, normalizeBindingChanges } from '../../../../packages/rp-core/src/assets/bindings.ts'
import { expandRoleplayMacros } from '../../../../packages/rp-core/src/macro/syntax.js'
import { materializeMvuProfile } from '../../../../packages/rp-core/src/mvu/materialize.js'
import { serializeLoreBookV3 } from '../../../../packages/rp-core/src/lore/activation.js'
import { createNamespaceSnapshot, normalizeStateBootstrap } from '../../../../packages/rp-core/src/state/definition.js'
import { normalizeProfile } from '../../../../packages/rp-core/src/story/profile.js'
import { messageTail, regenerationInput } from '../../../../packages/rp-core/src/story/projection.ts'
import { ModelHistoryService } from './model-history-service.ts'
import type { StoryEventInput, StoryMessage, StoryProfile, StorySnapshot, StoryState } from '../../../../packages/rp-core/src/types.ts'
import type { AssetRepository } from '../storage/asset-repository.ts'
import type { FileRepository } from '../storage/file-repository.ts'
import type { StoryRepository } from '../storage/story-repository.ts'
import { validateMessageInputs } from './message-input.ts'
import { storyVariables } from '../../../../packages/rp-core/src/story/variables.ts'

export class StoryService {
  constructor(readonly repository: StoryRepository, readonly assets: AssetRepository, readonly files: FileRepository) {}

  create(title: string, input: Partial<StoryProfile> = {}, useDefaults = true, creation?: { id: string; key: string }) {
    requireValue(typeof title === 'string' && title.trim().length > 0 && [...title].length <= 120, 'INVALID_REQUEST', '请填写不超过 120 字的故事名称。')
    return this.repository.database.transaction(() => {
      const defaults = this.assets.ensureDefaults()
      const profile = this.normalize({
        playerCharacterId: 'player', cast: [{ characterId: 'player', name: '我', controller: 'user' }],
        scene: { openingSource: 'skip' }, runtime: { executionMode: 'chat' }, ...input,
        resources: { ...(useDefaults ? { persona: { id: defaults.persona } } : {}), ...(useDefaults ? { preset: { id: defaults.preset } } : {}), lorebooks: [], writingStyles: useDefaults ? [{ id: defaults.writingStyle }] : [], ...input.resources },
      }, 0)
      const { bootstrap, openingText } = this.materialize(profile)
      const story = this.repository.create(title.trim(), profile, bootstrap, undefined, creation)
      if (openingText) this.repository.append(story.id, { type: 'message.added', data: { message: {
        id: randomUUID(), role: 'assistant', kind: 'opening', text: openingText,
        attachmentIds: [], turnId: randomUUID(), runId: null, createdAt: new Date().toISOString(),
      } } })
      return this.repository.snapshot(story.id)
    })
  }

  updateProfile(storyId: string, expectedRevision: number, input: StoryProfile) {
    return this.repository.mutate(storyId, expectedRevision, () => {
      const current = this.repository.snapshot(storyId)
      const profile = this.normalize(input, current.profile.revision)
      const blank = current.messages.every(message => message.kind === 'opening')
      const detachedCard = blank && !!current.profile.resources.card && !profile.resources.card
      if (detachedCard && profile.scene.openingSource === 'card') {
        const openingText = current.messages.find(message => message.kind === 'opening')?.text
        profile.scene = { title: profile.scene.title, openingSource: openingText ? 'custom' : 'skip', ...(openingText ? { openingText } : {}) }
      }
      const variables = storyVariables(profile), previousVariables = storyVariables(current.profile)
      const activateMvu = blank && variables.enabled && variables.mvu && !(previousVariables.enabled && previousVariables.mvu) && Object.keys(current.state.namespaces).length === 0
      const initializationChanged = activateMvu || JSON.stringify([profile.scene, profile.cast, profile.resources.card, profile.resources.persona, profile.resources.lorebooks]) !==
        JSON.stringify([current.profile.scene, current.profile.cast, current.profile.resources.card, current.profile.resources.persona, current.profile.resources.lorebooks])
      if (!blank) {
        requireValue(['openingSource', 'openingIndex', 'openingText'].every(key => profile.scene[key as keyof StoryProfile['scene']] === current.profile.scene[key as keyof StoryProfile['scene']]), 'STORY_ALREADY_STARTED', '故事开始后请直接编辑开场消息，不能重新初始化开场。', 409)
        this.repository.append(storyId, { type: 'profile.changed', data: { profile } })
      } else if (!initializationChanged) {
        this.repository.append(storyId, { type: 'profile.changed', data: { profile } })
      } else {
        const unavailableUnchangedCard = profile.scene.openingSource === 'card' && !this.assets.resolve(profile.resources.card?.id, 'character') &&
          profile.resources.card?.id === current.profile.resources.card?.id && JSON.stringify(profile.scene) === JSON.stringify(current.profile.scene)
        const materialized = unavailableUnchangedCard ? { bootstrap: current.state, openingText: current.messages.find(message => message.kind === 'opening')?.text ?? null } : this.materialize(profile)
        this.repository.append(storyId, { type: 'profile.changed', data: { profile, bootstrap: variables.enabled && !detachedCard ? materialized.bootstrap : current.state } })
        const opening = current.messages.find(message => message.kind === 'opening')
        if (opening) {
          if (materialized.openingText) this.repository.append(storyId, { type: 'message.edited', data: { messageId: opening.id, text: materialized.openingText } })
          else this.repository.append(storyId, { type: 'messages.removed', data: { messageIds: [opening.id], reason: 'delete' } })
        } else if (materialized.openingText) {
          this.repository.append(storyId, { type: 'message.added', data: { message: {
            id: randomUUID(), role: 'assistant', kind: 'opening', text: materialized.openingText,
            attachmentIds: [], turnId: randomUUID(), runId: null, createdAt: new Date().toISOString(),
          } } })
        }
      }
      return this.repository.snapshot(storyId)
    })
  }

  bindDuringRun(runId: string, input: unknown) {
    return this.repository.database.transaction(() => {
      const run = this.repository.run(runId)
      requireValue(run.status === 'running', 'RUN_STATE_CONFLICT', '当前生成已停止。', 409)
      const current = this.repository.snapshot(run.storyId)
      requireValue(current.profile.runtime.executionMode === 'agent', 'TOOL_NOT_ALLOWED', '请切换到 Agent 模式后修改资料绑定。', 403)
      const changes = normalizeBindingChanges(input)
      for (const [key, value] of Object.entries(changes)) {
        const kind = BINDING_KINDS[key as keyof typeof BINDING_KINDS]
        for (const id of Array.isArray(value) ? value : value === null ? [] : [value]) this.assets.get(String(id), kind)
      }
      const profile = this.normalize({ ...current.profile, resources: applyBindingChanges(current.profile, changes) }, current.profile.revision)
      this.repository.append(run.storyId, { type: 'profile.changed', data: { profile } })
      return profile
    })
  }

  rename(storyId: string, expectedRevision: number, title: string) {
    requireValue(typeof title === 'string' && title.trim().length > 0 && [...title].length <= 120, 'INVALID_REQUEST', '请填写不超过 120 字的故事名称。')
    return this.repository.mutate(storyId, expectedRevision, () => this.repository.append(storyId, { type: 'story.renamed', data: { title: title.trim() } }))
  }

  archive(storyId: string, expectedRevision: number, archived: boolean) {
    return this.repository.mutate(storyId, expectedRevision, () => this.repository.append(storyId, { type: 'story.archived', data: { archived } }))
  }

  send(storyId: string, requestId: string, inputs: { text: string; attachmentIds: string[] }[]) {
    requireValue(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128, 'INVALID_REQUEST', '这次发送缺少有效标识，请重试。')
    validateMessageInputs(inputs, this.files)
    const inputHash = createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
    return this.repository.enqueue({ storyId, requestId, inputHash, turnId: randomUUID() }, run => {
      const story = this.repository.snapshot(storyId)
      requireValue(!story.archived, 'STORY_ARCHIVED', '请先恢复这段故事，再继续对话。', 409)
      for (const input of inputs) this.repository.append(storyId, { type: 'message.added', data: { message: {
        id: randomUUID(), role: 'user', kind: 'message', text: input.text, attachmentIds: [...input.attachmentIds],
        turnId: run.turnId, runId: run.id, createdAt: new Date().toISOString(),
      } } })
    })
  }

  edit(storyId: string, expectedRevision: number, messageId: string, text: string) {
    requireValue(typeof text === 'string' && text.trim().length > 0 && [...text].length <= 200_000, 'INVALID_REQUEST', '请填写有效的消息内容。')
    return this.repository.mutate(storyId, expectedRevision, () => {
      const story = this.repository.snapshot(storyId)
      requireValue(story.messages.some(message => message.id === messageId), 'MESSAGE_NOT_FOUND', '这条消息已不存在。', 404)
      this.repository.append(storyId, { type: 'message.edited', data: { messageId, text } })
      return this.repository.snapshot(storyId)
    })
  }

  feedback(storyId: string, expectedRevision: number, messageId: string, rating: 'up' | 'down' | null, comment: string) {
    requireValue((rating === null || rating === 'up' || rating === 'down') && typeof comment === 'string' && [...comment].length <= 4000, 'INVALID_FEEDBACK', '反馈内容格式不正确。')
    return this.repository.mutate(storyId, expectedRevision, () => {
      const message = this.repository.snapshot(storyId).messages.find(item => item.id === messageId)
      requireValue(message?.role === 'assistant' && message.kind !== 'tool', 'MESSAGE_NOT_FOUND', '这条回复已不存在。', 404)
      this.repository.append(storyId, { type: 'message.feedback', data: { messageId, rating, comment: comment.trim() } })
      return this.repository.snapshot(storyId)
    })
  }

  remove(storyId: string, expectedRevision: number, messageId: string) {
    return this.repository.mutate(storyId, expectedRevision, () => {
      const ids = messageTail(this.repository.snapshot(storyId), messageId)
      this.repository.append(storyId, { type: 'messages.removed', data: { messageIds: ids, reason: 'delete' } })
      return this.repository.snapshot(storyId)
    })
  }

  regenerate(storyId: string, expectedRevision: number, messageId: string, requestId: string, editedText?: string) {
    requireValue(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128, 'INVALID_REQUEST', '这次发送缺少有效标识，请重试。')
    if (editedText !== undefined) requireValue(typeof editedText === 'string' && editedText.trim().length > 0 && [...editedText].length <= 200_000, 'INVALID_REQUEST', '请填写有效的消息内容。')
    const inputHash = createHash('sha256').update(JSON.stringify({ action: 'regenerate', messageId, editedText })).digest('hex')
    return this.repository.enqueue({ storyId, requestId, inputHash, turnId: randomUUID() }, run => {
      this.repository.assertRevision(storyId, expectedRevision)
      let current = this.repository.snapshot(storyId)
      requireValue(!current.archived, 'STORY_ARCHIVED', '请先恢复这段故事，再重新生成。', 409)
      regenerationInput(current, messageId)
      if (editedText !== undefined) {
        this.repository.append(storyId, { type: 'message.edited', data: { messageId, text: editedText } })
        current = this.repository.snapshot(storyId)
      }
      const replay = regenerationInput(current, messageId)
      const previousRunId = replay.inputs[0]!.runId
      requireValue(previousRunId, 'MESSAGE_NOT_REPLAYABLE', '这条输入缺少原始执行记录。', 409)
      this.repository.append(storyId, { type: 'messages.removed', data: { messageIds: replay.removeIds, reason: 'regenerate', replacement: { previousRunId, runId: run.id } } })
      for (const message of replay.inputs) this.repository.append(storyId, { type: 'message.added', data: { message: {
        ...message, id: randomUUID(), runId: run.id, turnId: run.turnId, createdAt: new Date().toISOString(),
      } } })
    })
  }

  fork(storyId: string, expectedRevision: number, messageId: string) {
    return this.repository.mutate(storyId, expectedRevision, () => {
      const source = this.repository.snapshot(storyId)
      const index = source.messages.findIndex(message => message.id === messageId)
      requireValue(index >= 0, 'MESSAGE_NOT_FOUND', '要继续的消息已不存在。', 404)
      const owners = new Set(source.messages.slice(0, index + 1).map(message => message.id))
      const history = new ModelHistoryService(this.repository)
      history.restoreBranch(storyId)
      const inherited = history.read({ ...source, messages: source.messages.slice(0, index + 1) }, undefined, null)
      const events = this.repository.projectionEvents(storyId)
      const first = events[0]
      requireValue(first?.type === 'story.created', 'STORY_CORRUPT', '故事缺少创建记录。', 500)
      const target = this.repository.create(`${source.title.slice(0, 110)} · 另一种展开`, first.data.profile, first.data.bootstrap, { storyId, messageId })
      for (const event of events.slice(1)) {
        let copy: StoryEventInput | undefined
        if (event.type === 'profile.changed') copy = event
        else if (event.type === 'message.added' && owners.has(event.data.message.id)) copy = event
        else if (event.type === 'message.edited' && owners.has(event.data.messageId)) copy = event
        else if (event.type === 'message.feedback' && owners.has(event.data.messageId)) copy = event
        else if (event.type === 'turn.committed' && owners.has(event.data.message.id)) copy = event
        else if (event.type === 'state.configured' && owners.has(event.data.ownerMessageId)) copy = event
        else if (event.type === 'summary.created' && event.data.sourceMessageIds.every(id => owners.has(id))) copy = event
        if (copy) this.repository.append(target.id, structuredClone(copy))
      }
      history.inherit(target.id, storyId, inherited)
      return this.repository.snapshot(target.id)
    })
  }

  private normalize(input: unknown, revision: number): StoryProfile {
    requireValue(Buffer.byteLength(JSON.stringify(input), 'utf8') <= 262_144, 'PROFILE_TOO_LARGE', '故事配置超过 256 KB，请缩短开场或自定义资料。')
    try { return normalizeProfile(input, revision) as StoryProfile }
    catch (error) { throw new RpError('INVALID_PROFILE', '故事配置不完整或格式不正确。', 400, error instanceof Error ? error.message : undefined) }
  }

  private materialize(profile: StoryProfile): { bootstrap: StoryState; openingText: string | null } {
    const variables = storyVariables(profile)
    const card = this.assets.resolve(profile.resources.card?.id, 'character')
    const persona = this.assets.resolve(profile.resources.persona?.id, 'persona')
    if (persona) {
      const player = profile.cast.find(member => member.controller === 'user')
      if (player) player.name = persona.name
    }
    if (profile.scene.openingSource === 'card') {
      requireValue(card, 'ASSET_NOT_FOUND', '请先选择一张角色卡。', 404)
      const openings = [card.data.firstMessage, ...(Array.isArray(card.data.alternateGreetings) ? card.data.alternateGreetings : [])]
      const selected = openings[profile.scene.openingIndex ?? 0]
      requireValue(typeof selected === 'string', 'INVALID_OPENING', '所选开场已不存在，请重新选择。')
      profile.scene.openingText = selected
    }
    const books = profile.resources.lorebooks.flatMap(binding => {
      const book = this.assets.resolve(binding.id, 'lorebook')
      return book ? [serializeLoreBookV3(book.data)] : []
    })
    const materialized = variables.enabled && variables.mvu ? materializeMvuProfile({ profile, previousProfile: undefined,
      character: card?.data, source: card?.data.sourcePayload, books, blank: true,
    }) : undefined
    const bootstrap: StoryState = { namespaces: {} }
    if (materialized?.stateBootstrap) {
      const normalized = normalizeStateBootstrap(materialized.stateBootstrap)
      for (const namespace of normalized.namespaces) bootstrap.namespaces[namespace.namespace] = createNamespaceSnapshot(namespace)
    }
    const original = profile.scene.openingSource === 'skip' ? null
      : materialized && 'openingMessageText' in materialized ? materialized.openingMessageText
        : profile.scene.openingText ?? null
    const openingText = original ? expandRoleplayMacros(original, {
      characterName: card?.name, userName: profile.cast.find(member => member.controller === 'user')?.name,
    }) : null
    return { bootstrap, openingText }
  }
}
