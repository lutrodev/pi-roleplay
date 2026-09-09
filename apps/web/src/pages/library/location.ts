import { ASSET_KINDS, type AssetKind } from '../../../../../packages/rp-core/src/types.ts'

const recordId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function librarySearch(search: Record<string, unknown>): { kind?: AssetKind; edit?: string; from?: string } {
  return {
    ...(typeof search.kind === 'string' && ASSET_KINDS.includes(search.kind as AssetKind) ? { kind: search.kind as AssetKind } : {}),
    ...(typeof search.edit === 'string' && recordId.test(search.edit) ? { edit: search.edit } : {}),
    ...(typeof search.from === 'string' && recordId.test(search.from) ? { from: search.from } : {}),
  }
}
