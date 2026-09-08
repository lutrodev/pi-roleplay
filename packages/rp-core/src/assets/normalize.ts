import { randomUUID } from 'node:crypto'
import { RpError, requireValue } from '../errors.ts'
import { objectInput } from '../input.ts'
import { normalizeLoreBook } from '../lore/activation.js'
import { compileStateCondition } from '../state/condition.js'
import { serializeCharacterCardV3 } from '../character/character-card.js'
import type { AssetKind, JsonObject, JsonValue } from '../types.ts'
import { normalizePersona, validateEditablePersona } from './persona.js'
import { normalizePreset, validateEditablePreset } from './preset.js'
import { normalizeStyle, validateEditableStyle } from './writing-style.js'

const CHARACTER_TEXT = ['name', 'description', 'personality', 'scenario', 'firstMessage', 'messageExample', 'creatorNotes', 'creator', 'characterVersion', 'nickname']
const CHARACTER_LISTS = ['tags', 'alternateGreetings', 'groupOnlyGreetings']
const CHARACTER_FIELDS = new Set([...CHARACTER_TEXT, ...CHARACTER_LISTS, 'extensions', 'acceptedPromptPaths'])

export const ASSET_LIMITS = Object.freeze({
  character: 2_000_000,
  lorebook: 2_000_000,
  persona: 30_000,
  preset: 100_000,
  writingStyle: 30_000,
})

function normalizeCharacter(value: JsonObject): JsonObject {
  requireValue(Object.keys(value).every(key => CHARACTER_FIELDS.has(key)), 'INVALID_REQUEST', '角色资料包含不可编辑的字段。')
  requireValue(typeof value.name === 'string' && value.name.trim().length > 0, 'INVALID_REQUEST', '请填写角色名称。')
  const output: JsonObject = {}
  for (const key of CHARACTER_TEXT) {
    requireValue(value[key] === undefined || typeof value[key] === 'string', 'INVALID_REQUEST', '角色文字字段必须是文本。')
    output[key] = (value[key] as string | undefined)?.trim() ?? ''
  }
  for (const key of [...CHARACTER_LISTS, 'acceptedPromptPaths']) {
    const items = value[key] ?? []
    requireValue(Array.isArray(items) && items.every(item => typeof item === 'string'), 'INVALID_REQUEST', '标签、开场白和提示选择必须是文字列表。')
    output[key] = [...new Set(items as string[])]
  }
  const extensions = value.extensions ?? {}
  objectInput(extensions)
  output.extensions = structuredClone(extensions)
  return output
}

export function countText(value: JsonValue): number {
  if (typeof value === 'string') return [...value].length
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countText(item), 0)
  if (value && typeof value === 'object') return Object.values(value).reduce<number>((sum, item) => sum + countText(item), 0)
  return 0
}

/** The source copy and normalized view describe one card; do not charge their text twice. */
export function countCharacterText(data: JsonObject): number {
  const payload = serializeCharacterCardV3(data, {
    sourcePayload: data.sourcePayload as JsonObject | undefined,
    characterBook: data.characterBook as JsonObject | undefined,
  })
  return countText(payload as JsonObject) + countText(data.quarantinedPrompts ?? [])
}

export function normalizeAsset(kind: AssetKind, input: unknown, assetId: string = randomUUID(), update = false): JsonObject {
  objectInput(input)
  let data: JsonObject
  try {
    switch (kind) {
      case 'character': data = normalizeCharacter(input); break
      case 'persona':
        validateEditablePersona(input)
        data = normalizePersona(input, ASSET_LIMITS.persona)
        break
      case 'preset':
        validateEditablePreset(input, { update })
        data = normalizePreset(input, { maxTextCharacters: ASSET_LIMITS.preset, maxFields: 32 }, update)
        break
      case 'writingStyle':
        validateEditableStyle(input)
        data = normalizeStyle(input, { maxTextCharacters: ASSET_LIMITS.writingStyle })
        break
      case 'lorebook': {
        requireValue(typeof input.name === 'string' && input.name.trim().length > 0, 'INVALID_REQUEST', '请填写世界书名称。')
        requireValue(Array.isArray(input.entries), 'INVALID_REQUEST', '世界书条目必须是列表。')
        requireValue(input.entries.length <= 4096, 'LIMIT_EXCEEDED', '一本世界书最多包含 4096 个条目。')
        data = normalizeLoreBook({ ...input, id: assetId }, assetId) as unknown as JsonObject
        requireValue((data.entries as JsonValue[]).length === input.entries.length, 'INVALID_REQUEST', '世界书包含无法识别的条目，请检查内容。')
        for (const entry of data.entries as JsonObject[]) if (typeof entry.stateCondition === 'string') compileStateCondition(entry.stateCondition)
        break
      }
    }
  } catch (error) {
    if (error instanceof RpError) throw error
    const code = error && typeof error === 'object' && 'code' in error && error.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'INVALID_REQUEST'
    throw new RpError(code, code === 'LIMIT_EXCEEDED' ? '资料内容超过了允许的长度。' : '资料内容不完整或格式不正确。', 400, error instanceof Error ? error.message : undefined)
  }
  requireValue(countText(data) <= ASSET_LIMITS[kind], 'LIMIT_EXCEEDED', '资料内容超过了允许的长度。')
  return structuredClone(data)
}
