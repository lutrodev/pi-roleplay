import { objectInput } from '../input.ts'
import { validateEditableLoreEntries } from './lore-edit.ts'
import { requireValue } from '../errors.ts'
import type { AssetKind, AssetRecord, JsonObject } from '../types.ts'

const CHARACTER_FIELDS = ['name', 'description', 'personality', 'scenario', 'firstMessage', 'messageExample', 'alternateGreetings', 'creatorNotes', 'tags']
const RETAINED_CHARACTER_FIELDS = [...CHARACTER_FIELDS, 'creator', 'characterVersion', 'nickname', 'groupOnlyGreetings', 'extensions', 'acceptedPromptPaths']

/** Model-facing patches preserve all unrelated editable content, including the UI's trust choices. */
export function prepareModelAsset(kind: AssetKind, input: unknown, current?: AssetRecord): JsonObject {
  objectInput(input)
  if (kind === 'character') {
    fields(input, CHARACTER_FIELDS)
    const retained = current ? Object.fromEntries(RETAINED_CHARACTER_FIELDS.filter(key => current.data[key] !== undefined).map(key => [key, structuredClone(current.data[key]!)])) : {}
    return { ...retained, ...input }
  }
  if (kind === 'lorebook') {
    fields(input, ['name', 'entries'])
    if (input.entries !== undefined) validateEditableLoreEntries(input.entries)
    // Imported scan options and entry identities survive a name-only or ordered-entry patch.
    return { ...(current?.data ?? {}), ...input }
  }
  return input
}

export function modelReadableAsset(asset: AssetRecord): JsonObject {
  const data = structuredClone(asset.data)
  if (asset.kind === 'character') {
    delete data.sourcePayload
    data.quarantinedPrompts = Array.isArray(data.quarantinedPrompts) ? data.quarantinedPrompts.map(item => ({
      path: item && typeof item === 'object' && !Array.isArray(item) && typeof item.path === 'string' ? item.path : 'unknown', status: 'quarantined',
    })) : []
  }
  return { ...data, id: asset.id, kind: asset.kind, name: asset.name, revision: asset.revision, avatarFileId: asset.avatarFileId }
}

function fields(value: JsonObject, allowed: string[]) {
  requireValue(Object.keys(value).length > 0 && Object.keys(value).every(key => allowed.includes(key)), 'INVALID_ASSET_FIELDS', '资料包含不可编辑的字段，或没有提供修改内容。')
}
