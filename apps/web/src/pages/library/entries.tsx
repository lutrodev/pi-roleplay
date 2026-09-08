import type { JsonObject } from '../../../../../packages/rp-core/src/types.ts'
import { PresetFields } from './preset-fields.tsx'
import { LorebookEntries } from './lorebook-fields.tsx'

export function EntryEditor({ kind, entries, onChange, disabled = false }: { kind: 'preset' | 'lorebook'; entries: JsonObject[]; onChange: (entries: JsonObject[]) => void; disabled?: boolean }) {
  return <fieldset disabled={disabled}>{kind === 'preset' ? <PresetFields entries={entries} onChange={onChange} disabled={disabled} /> : <LorebookEntries entries={entries} onChange={onChange} disabled={disabled} />}</fieldset>
}
