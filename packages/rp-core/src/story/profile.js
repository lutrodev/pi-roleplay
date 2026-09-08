import { MAX_CONTEXT_SLOTS, normalizeCustomContextSources, RP_CONTEXT_BUILD_VERSION } from '../context/build.js'
import { normalizeVariableSettings } from './variables.ts'
import { normalizeSessionModelRoute, normalizeSubagentRoutes } from '../agents/session-routes.ts'

const MAX_OPENING_CHARACTERS = 100000

const MAX_PLAYER_NAME_CHARACTERS = 80

export function normalizeProfile(request, currentRevision, defaultExecutionMode = 'chat') {
  if (!record(request)) throw new Error('roleplay session profile must be an object')
  const expectedRevision = request.expectedRevision ?? currentRevision
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== currentRevision) {
    throw new Error(`roleplay session revision conflict: expected ${String(expectedRevision)}, current ${currentRevision}`)
  }
  const cast = normalizeCast(request.cast)
  const playerCharacterId = optionalString(request.playerCharacterId)
  return {
    revision: currentRevision + 1,
    ...(playerCharacterId === undefined ? {} : { playerCharacterId }),
    cast,
    scene: normalizeScene(request.scene),
    resources: normalizeResources(request.resources),
    runtime: normalizeRuntime(request.runtime, defaultExecutionMode),
    variables: normalizeVariableSettings(request.variables),
    ...(request.contextBuild === undefined ? {} : { contextBuild: normalizeContextBuild(request.contextBuild) }),
  }
}

function normalizeCast(value) {
  if (!Array.isArray(value)) throw new Error('roleplay cast must be an array')
  const ids = new Set()
  return value.map(member => {
    if (!record(member) || typeof member.characterId !== 'string' || member.characterId.length === 0
      || (member.controller !== 'user' && member.controller !== 'agent')) {
      throw new Error('each cast member requires characterId and user|agent controller')
    }
    if (ids.has(member.characterId)) throw new Error(`duplicate cast character ${member.characterId}`)
    ids.add(member.characterId)
    const name = optionalString(member.name)
    if (name !== undefined && [...name].length > MAX_PLAYER_NAME_CHARACTERS) throw new Error(`cast member name must not exceed ${MAX_PLAYER_NAME_CHARACTERS} characters`)
    return { characterId: member.characterId, ...(name === undefined ? {} : { name }), controller: member.controller }
  })
}

function normalizeScene(value) {
  if (value === undefined) return {}
  if (!record(value)) throw new Error('scene must be an object')
  const id = optionalString(value.id)
  const title = optionalString(value.title)
  const openingIndex = value.openingIndex === undefined ? undefined : normalizeOpeningIndex(value.openingIndex)
  const openingSource = value.openingSource === undefined ? undefined : normalizeOpeningSource(value.openingSource)
  const openingText = value.openingText === undefined ? undefined : normalizeOpeningText(value.openingText)
  const openingAnchorRevision = value.openingAnchorRevision === undefined
    ? undefined
    : optionalPositiveInteger(value.openingAnchorRevision, 'scene.openingAnchorRevision')
  return {
    ...(id === undefined ? {} : { id }),
    ...(title === undefined ? {} : { title }),
    ...(openingIndex === undefined ? {} : { openingIndex }),
    ...(openingSource === undefined ? {} : { openingSource }),
    ...(openingText === undefined ? {} : { openingText }),
    ...(openingAnchorRevision === undefined ? {} : { openingAnchorRevision }),
  }
}

function normalizeOpeningIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('scene.openingIndex must be a non-negative safe integer')
  return value
}

function normalizeOpeningSource(value) {
  if (!['card', 'custom', 'skip'].includes(value)) throw new Error('scene.openingSource must be card, custom, or skip')
  return value
}

function normalizeOpeningText(value) {
  if (typeof value !== 'string') throw new RpSessionError('INVALID_REQUEST', 'openingText must be a string')
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()
  const characters = [...normalized].length
  if (characters < 1) throw new RpSessionError('INVALID_REQUEST', 'openingText must not be empty')
  if (characters > MAX_OPENING_CHARACTERS) {
    throw new RpSessionError('LIMIT_EXCEEDED', `openingText exceeds ${MAX_OPENING_CHARACTERS} characters`)
  }
  return normalized
}

function normalizeResources(value) {
  if (value === undefined) return { lorebooks: [], writingStyles: [] }
  if (!record(value)) throw new Error('resources must be an object')
  if (Object.prototype.hasOwnProperty.call(value, 'characters')) {
    throw new Error('resources.characters is no longer supported; use the singular resources.card binding')
  }
  const card = value.card === undefined ? undefined : resourceBinding(value.card, 'card')
  const persona = value.persona === undefined ? undefined : resourceBinding(value.persona, 'persona')
  const preset = value.preset === undefined ? undefined : resourceBinding(value.preset, 'preset')
  return {
    ...(card === undefined ? {} : { card }),
    lorebooks: bindingArray(value.lorebooks, 'lorebooks'),
    ...(persona === undefined ? {} : { persona }),
    ...(preset === undefined ? {} : { preset }),
    writingStyles: bindingArray(value.writingStyles, 'writingStyles'),
  }
}

function normalizeRuntime(value, defaultExecutionMode) {
  if (value === undefined) return { executionMode: defaultExecutionMode }
  if (!record(value)) throw new Error('runtime must be an object')
  const executionMode = value.executionMode ?? defaultExecutionMode
  if (executionMode !== 'chat' && executionMode !== 'agent') throw new Error('runtime.executionMode must be chat or agent')
  const provider = optionalString(value.provider)
  const model = optionalString(value.model)
  if ((provider === undefined) !== (model === undefined)) throw new Error('runtime.provider and runtime.model must be configured together')
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string' || !value.reasoningEffort.trim() || value.reasoningEffort.length > 64)) {
    throw new Error('runtime.reasoningEffort must be a non-empty string of at most 64 characters')
  }
  const reasoningEffort = optionalString(value.reasoningEffort)
  const maxSteps = optionalPositiveInteger(value.maxSteps, 'runtime.maxSteps')
  const writerRoute = value.writerRoute === undefined ? undefined : normalizeSessionModelRoute(value.writerRoute)
  const subagentRoutes = value.subagentRoutes === undefined ? undefined : normalizeSubagentRoutes(value.subagentRoutes)
  return {
    executionMode,
    ...(model === undefined ? {} : { provider, model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(writerRoute === undefined ? {} : { writerRoute }),
    ...(subagentRoutes === undefined || Object.keys(subagentRoutes).length === 0 ? {} : { subagentRoutes }),
  }
}

function bindingArray(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${field} must be a resource binding array`)
  if (field === 'writingStyles' && value.length > 16) throw new RpSessionError('LIMIT_EXCEEDED', '每段故事最多选择 16 条文风。')
  const ids = new Set()
  return value.map(binding => {
    const normalized = resourceBinding(binding, `${field} entries`)
    if (ids.has(normalized.id)) throw new Error(`duplicate ${field} binding ${normalized.id}`)
    ids.add(normalized.id)
    return normalized
  })
}

function resourceBinding(binding, field) {
  if (!record(binding) || typeof binding.id !== 'string' || binding.id.length === 0) throw new Error(`${field} require an id`)
  if (Object.keys(binding).some(key => key !== 'id')) throw new Error(`${field} must contain only a live asset id`)
  return { id: binding.id }
}

export class RpSessionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RpSessionError'
    this.code = code
  }
}

function optionalPositiveInteger(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`)
  return value
}

function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function normalizeContextBuild(value) {
  if (!record(value) || value.version !== RP_CONTEXT_BUILD_VERSION || !Array.isArray(value.slots) || value.slots.length > MAX_CONTEXT_SLOTS) {
    throw new Error(`contextBuild must contain version ${RP_CONTEXT_BUILD_VERSION} and at most ${MAX_CONTEXT_SLOTS} slots`)
  }
  if (value.sectionTags !== undefined && typeof value.sectionTags !== 'boolean') {
    throw new Error('contextBuild sectionTags must be a boolean')
  }
  const legacySectionTag = value.sectionTags ?? true
  const slotIds = new Set()
  const sourceIds = new Set()
  const slots = value.slots.map((slot, index) => {
    if (!record(slot) || typeof slot.id !== 'string' || !/^[a-z0-9][a-z0-9._:-]*$/.test(slot.id) || slotIds.has(slot.id)) {
      throw new Error(`contextBuild slot ${index} has an invalid or duplicate id`)
    }
    slotIds.add(slot.id)
    if (typeof slot.label !== 'string' || slot.label.trim().length === 0 || [...slot.label.trim()].length > 80) {
      throw new Error(`contextBuild slot "${slot.id}" requires a label of at most 80 characters`)
    }
    if (slot.idle !== undefined && typeof slot.idle !== 'boolean') throw new Error(`contextBuild slot "${slot.id}" idle must be a boolean`)
    if (slot.sectionTag !== undefined && typeof slot.sectionTag !== 'boolean') throw new Error(`contextBuild slot "${slot.id}" sectionTag must be a boolean`)
    if (!Array.isArray(slot.sourceIds) || slot.sourceIds.length > 128) throw new Error(`contextBuild slot "${slot.id}" sourceIds is invalid`)
    for (const sourceId of slot.sourceIds) {
      if (typeof sourceId !== 'string' || sourceIds.has(sourceId)) throw new Error(`contextBuild source "${String(sourceId)}" is invalid or duplicated`)
      if (slot.idle === true && ['rp.conversation-summary', 'rp.conversation', 'rp.current-input'].includes(sourceId)) {
        throw new Error(`context source "${sourceId}" must remain active`)
      }
      sourceIds.add(sourceId)
    }
    return {
      id: slot.id,
      label: slot.label.trim(),
      sourceIds: [...slot.sourceIds],
      ...(slot.locked === true ? { locked: true } : {}),
      ...(slot.idle === true ? { idle: true } : {}),
      sectionTag: slot.sectionTag ?? legacySectionTag,
    }
  })
  const customSources = normalizeCustomContextSources({ ...value, slots })
  return {
    version: RP_CONTEXT_BUILD_VERSION,
    slots,
    ...(customSources.length === 0 ? {} : { customSources }),
  }
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
