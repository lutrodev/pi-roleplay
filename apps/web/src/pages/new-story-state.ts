import type { JsonObject, StoryProfile } from '../../../../packages/rp-core/src/types.ts'
import { normalizeProfile } from '../../../../packages/rp-core/src/story/profile.js'

export interface NewConversationOptions {
  title: string
  workspaceId: string
  profile: StoryProfile
  includeAssociatedLorebooks: boolean
  /** Auto-added books retained when the user edits or reorders the visible selection. */
  autoLorebookIds?: string[]
}

/** Keep original indices: the server resolves the same greeting from the live card. */
export function cardOpenings(data?: JsonObject) {
  return [data?.firstMessage, ...(Array.isArray(data?.alternateGreetings) ? data.alternateGreetings : [])]
    .flatMap((text, index) => typeof text === 'string' && text.trim() ? [{ index, text }] : [])
}

export function selectedLorebookIds(value: NewConversationOptions, associated: { id: string }[]): string[] {
  return [...new Set([
    ...value.profile.resources.lorebooks.map(book => book.id),
    ...(value.includeAssociatedLorebooks && value.profile.resources.card ? associated.map(book => book.id) : []),
  ])]
}

/** Make an explicit selection authoritative, retaining which books came from the card. */
export function selectLorebooks(value: NewConversationOptions, ids: string[], associated: { id: string }[]): NewConversationOptions {
  const manual = new Set(value.profile.resources.lorebooks.map(book => book.id))
  const automatic = new Set([
    ...(value.autoLorebookIds ?? []),
    ...(value.includeAssociatedLorebooks && value.profile.resources.card ? associated.filter(book => !manual.has(book.id)).map(book => book.id) : []),
  ])
  const selected = [...new Set(ids)]
  return { ...value, includeAssociatedLorebooks: false, autoLorebookIds: selected.filter(id => automatic.has(id)),
    profile: { ...value.profile, resources: { ...value.profile.resources, lorebooks: selected.map(id => ({ id })) } },
  }
}

export function selectCharacter(value: NewConversationOptions, id: string | undefined): NewConversationOptions {
  const automatic = new Set(value.autoLorebookIds)
  return { ...value, includeAssociatedLorebooks: true, autoLorebookIds: undefined, profile: { ...value.profile,
    resources: { ...value.profile.resources, card: id ? { id } : undefined, lorebooks: value.profile.resources.lorebooks.filter(book => !automatic.has(book.id)) },
    scene: { ...value.profile.scene, openingSource: id ? 'card' : 'skip', openingIndex: 0 },
  } }
}

export function creationProfile(value: NewConversationOptions, associated: { id: string }[]): StoryProfile {
  const { profile } = value, scene = profile.scene
  const profileInput = {
    ...profile,
    scene: { ...scene, openingText: scene.openingSource === 'custom' ? scene.openingText?.trim() : undefined, openingIndex: scene.openingSource === 'card' ? scene.openingIndex ?? 0 : undefined },
    resources: { ...profile.resources, lorebooks: selectedLorebookIds(value, associated).map(id => ({ id })) },
  }
  // Keep the serialized request identical before and after restoring a local draft.
  return normalizeProfile(profileInput, 0) as StoryProfile
}

/** Validate persisted local configuration while allowing an unfinished custom opening. */
export function readNewConversationOptions(raw: string | null, initial: NewConversationOptions): NewConversationOptions {
  if (!raw) return initial
  const value = JSON.parse(raw)
  if (!value || typeof value.title !== 'string' || [...value.title].length > 120 || typeof value.workspaceId !== 'string' || typeof value.includeAssociatedLorebooks !== 'boolean') throw new Error('新会话的本地设置无法读取，已恢复默认设置。输入内容仍保留。')
  if (value.autoLorebookIds !== undefined && (!Array.isArray(value.autoLorebookIds) || value.autoLorebookIds.some((id: unknown) => typeof id !== 'string' || !id.trim()))) throw new Error('新会话的本地设置无法读取，已恢复默认设置。输入内容仍保留。')
  const scene = value.profile?.scene
  const unfinishedOpening = scene?.openingSource === 'custom' && typeof scene.openingText === 'string' && !scene.openingText.trim()
  const profile = normalizeProfile({ ...value.profile, scene: unfinishedOpening ? { ...scene, openingText: undefined } : scene }, 0) as StoryProfile
  return { title: value.title, workspaceId: value.workspaceId, includeAssociatedLorebooks: value.includeAssociatedLorebooks, ...(value.autoLorebookIds ? { autoLorebookIds: [...new Set<string>(value.autoLorebookIds)] } : {}), profile: unfinishedOpening ? { ...profile, scene: { ...profile.scene, openingText: scene.openingText } } : profile }
}
