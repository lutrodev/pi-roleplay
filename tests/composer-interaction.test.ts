import { describe, expect, it } from 'vitest'
import { composerKeyAction, editorKeyAction } from '../apps/web/src/pages/story/draft.ts'

const key = (overrides: Partial<Parameters<typeof composerKeyAction>[0]> = {}) => ({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...overrides })
describe('conversation input keyboard contract', () => {
  it('uses the busy Enter preference, reverses it with Ctrl/Command, and steers all only with empty input', () => {
    expect(composerKeyAction(key(), false, false, 'queue')).toBe('queue')
    expect(composerKeyAction(key({ ctrlKey: true }), false, false, 'queue')).toBe('steer')
    expect(composerKeyAction(key(), false, false, 'steer')).toBe('steer')
    expect(composerKeyAction(key({ metaKey: true }), false, false, 'steer')).toBe('queue')
    expect(composerKeyAction(key({ ctrlKey: true }), false, true, 'queue')).toBe('steer-pending')
    expect(composerKeyAction(key({ isComposing: true, ctrlKey: true }), false, true, 'queue')).toBeUndefined()
    expect(composerKeyAction(key({ shiftKey: true }), false, false, 'queue')).toBeUndefined()
    expect(composerKeyAction(key(), true, false, 'steer')).toBeUndefined()
  })
  it('sends with desktop Enter and keeps Shift+Enter as a newline', () => {
    expect(composerKeyAction(key(), false, false)).toBe('send')
    expect(composerKeyAction(key({ shiftKey: true }), false, false)).toBeUndefined()
    expect(composerKeyAction(key({ altKey: true }), false, false)).toBeUndefined()
  })
  it('never submits CJK composition, including Safari keyCode 229', () => {
    expect(composerKeyAction(key({ isComposing: true }), false, false)).toBeUndefined()
    expect(composerKeyAction(key({ keyCode: 229 }), false, false)).toBeUndefined()
    expect(composerKeyAction(key({ isComposing: true, metaKey: true }), false, false)).toBeUndefined()
  })
  it('keeps mobile Enter as a newline while supporting an attached keyboard send shortcut', () => {
    expect(composerKeyAction(key(), true, false)).toBeUndefined()
    expect(composerKeyAction(key({ ctrlKey: true }), true, false)).toBe('send')
    expect(composerKeyAction(key({ metaKey: true }), true, false)).toBe('send')
  })
  it('restores prior input only on an unmodified Up key in an empty composer', () => {
    expect(composerKeyAction(key({ key: 'ArrowUp' }), false, true)).toBe('restore')
    expect(composerKeyAction(key({ key: 'ArrowUp' }), false, false)).toBeUndefined()
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey', 'isComposing']) expect(composerKeyAction(key({ key: 'ArrowUp', [modifier]: true }), false, true)).toBeUndefined()
  })
})

describe('inline message editing keyboard contract', () => {
  it('keeps Enter as a newline and submits only with the save shortcut', () => {
    expect(editorKeyAction(key())).toBeUndefined()
    expect(editorKeyAction(key({ shiftKey: true }))).toBeUndefined()
    expect(editorKeyAction(key({ metaKey: true }))).toBe('save')
    expect(editorKeyAction(key({ ctrlKey: true }))).toBe('save')
    expect(editorKeyAction(key({ metaKey: true, shiftKey: true }))).toBeUndefined()
  })
  it('does not save or cancel while the Chinese input method handles a key', () => {
    for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
      expect(editorKeyAction(key({ metaKey: true, ...composing }))).toBeUndefined()
      expect(editorKeyAction(key({ key: 'Escape', ...composing }))).toBeUndefined()
    }
    expect(editorKeyAction(key({ key: 'Escape' }))).toBe('cancel')
  })
})
