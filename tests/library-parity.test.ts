import { describe, expect, it } from 'vitest'
import { changePresetPosition, insertPresetField, moveEntry, reorderEntries } from '../packages/rp-core/src/lore/editing.ts'

describe('visible library order matches actual prompt order', () => {
  it('moves preset fields only inside their top/bottom group', () => {
    const fields = [{ id: 'a', position: 'top' }, { id: 'b', position: 'bottom' }, { id: 'c', position: 'top' }]
    expect(moveEntry(fields, 0, 1, true).map(field => field.id)).toEqual(['c', 'b', 'a'])
    expect(moveEntry(fields, 1, 1, true)).toBe(fields)
    expect(moveEntry(fields, 1, -1, true)).toBe(fields)
  })
  it('keeps filtered-out records and other levels fixed while persisting lore activation order', () => {
    const entries = [{ id: 'a', level: 'worldDescription', order: 0 }, { id: 'hidden', level: 'worldDescription', order: 1 }, { id: 'b', level: 'worldDescription', order: 2 }, { id: 'rule', level: 'importantRules', order: 0 }]
    const next = reorderEntries(entries, ['b', 'a'])
    expect(next.map(entry => [entry.id, entry.order])).toEqual([['b', 0], ['hidden', 1], ['a', 2], ['rule', 0]])
    expect(reorderEntries(next, ['a', 'b'])).toEqual(entries)
    expect(entries[0]?.id).toBe('a')
  })
  it('relocates a preset field to the end of the chosen group without losing its text, identity or tag preference', () => {
    const moved = { id: 'a', position: 'top', name: 'First', content: 'Keep {{macros}} intact', description: 'Purpose', sectionTag: false }
    const fields = [moved, { id: 'b', position: 'top' }, { id: 'c', position: 'bottom' }]
    const next = changePresetPosition(fields, 'a', 'bottom')
    expect(next.map(field => field.id)).toEqual(['b', 'c', 'a'])
    expect(next[2]).toEqual({ ...moved, position: 'bottom' })
    expect(fields[0]).toBe(moved)
    expect(moved.position).toBe('top')
    expect(changePresetPosition(next, 'a', 'bottom')).toBe(next)
  })
  it('inserts new preset fields at their group end, including empty groups', () => {
    const fields = [{ id: 'a', position: 'top' }, { id: 'b', position: 'bottom' }]
    expect(insertPresetField(fields, { id: 'new', position: 'top' }).map(field => field.id)).toEqual(['a', 'new', 'b'])
    expect(insertPresetField([fields[1]!], { id: 'new', position: 'top' }).map(field => field.id)).toEqual(['new', 'b'])
    expect(insertPresetField([fields[0]!], { id: 'new', position: 'bottom' }).map(field => field.id)).toEqual(['a', 'new'])
  })
})
