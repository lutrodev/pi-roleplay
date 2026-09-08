import { objectInput } from '../input.ts'
import { requireValue } from '../errors.ts'
import type { AssetKind, JsonObject, StoryProfile } from '../types.ts'

export const BINDING_KINDS = { cardId: 'character', personaId: 'persona', presetId: 'preset', lorebookIds: 'lorebook', writingStyleIds: 'writingStyle' } as const
export const GUIDE_NAMES: Record<AssetKind, string> = { character: 'rp-guide-character-card', lorebook: 'rp-guide-lorebook', persona: 'rp-guide-persona', preset: 'rp-guide-preset', writingStyle: 'rp-guide-writing-style' }

export function boundAssetIds(profile: StoryProfile, kind: AssetKind): string[] {
  const refs = profile.resources
  if (kind === 'lorebook') return refs.lorebooks.map(item => item.id)
  if (kind === 'writingStyle') return refs.writingStyles.map(item => item.id)
  const id = (kind === 'character' ? refs.card : kind === 'persona' ? refs.persona : refs.preset)?.id
  return id ? [id] : []
}

export function normalizeBindingChanges(value: unknown): JsonObject {
  objectInput(value)
  requireValue(Object.keys(value).length > 0 && Object.keys(value).every(key => Object.hasOwn(BINDING_KINDS, key)), 'INVALID_BINDING', '请提供需要修改的资料绑定。')
  const result: JsonObject = {}
  for (const [key, input] of Object.entries(value)) {
    if (key === 'lorebookIds' || key === 'writingStyleIds') {
      const maximum = key === 'writingStyleIds' ? 16 : 128
      requireValue(Array.isArray(input) && input.length <= maximum && input.every(validId), 'INVALID_BINDING', `这份资料列表最多包含 ${maximum} 个有效 ID。`)
      result[key] = [...new Set(input as string[])]
    } else {
      requireValue(input === null || validId(input), 'INVALID_BINDING', '资料绑定必须为有效 ID，或使用 null 清除。')
      result[key] = input
    }
  }
  return result
}

export function applyBindingChanges(profile: StoryProfile, changes: JsonObject): StoryProfile['resources'] {
  const refs = structuredClone(profile.resources)
  for (const [key, field] of [['cardId', 'card'], ['personaId', 'persona'], ['presetId', 'preset']] as const) {
    if (!Object.hasOwn(changes, key)) continue
    if (changes[key] === null) delete refs[field]
    else refs[field] = { id: changes[key] as string }
  }
  for (const [key, field] of [['lorebookIds', 'lorebooks'], ['writingStyleIds', 'writingStyles']] as const) {
    if (Object.hasOwn(changes, key)) refs[field] = (changes[key] as string[]).map(id => ({ id }))
  }
  return refs
}

export function addAssetBinding(profile: StoryProfile, kind: AssetKind, id: string): JsonObject {
  const key = Object.entries(BINDING_KINDS).find(([, value]) => value === kind)![0]
  return { [key]: kind === 'lorebook' || kind === 'writingStyle' ? [...new Set([...boundAssetIds(profile, kind), id])] : id }
}

function validId(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 }
