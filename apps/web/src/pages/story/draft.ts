import { useEffect, useRef, useState } from 'react'
import type { FileRecord } from '../../../../../packages/rp-core/src/types.ts'
import { referenceText, withReferences } from '../../lib/reference-text.ts'

export interface Draft { text: string; files: FileRecord[]; request?: { payload: string; id: string } }
const transferredDrafts = new Map<string, Draft>()
export function clearStoryDraft(storyId: string) {
  transferredDrafts.delete(storyId)
  try { sessionStorage.removeItem(`rp-draft:${storyId}`) } catch { /* Browser storage may be unavailable. */ }
}
export function transferStoryDraft(storyId: string, draft: Draft) {
  transferredDrafts.set(storyId, draft)
  try { sessionStorage.setItem(`rp-draft:${storyId}`, JSON.stringify(draft)) } catch { /* The in-memory handoff keeps the first input available. */ }
}
function stored(storyId: string): Draft {
  const transferred = transferredDrafts.get(storyId)
  if (transferred) return transferred
  try {
    const value = JSON.parse(sessionStorage.getItem(`rp-draft:${storyId}`) ?? '{}')
    if (typeof value.text === 'string' && Array.isArray(value.files) && value.files.every((file: FileRecord) => file && typeof file.id === 'string' && typeof file.name === 'string' && typeof file.size === 'number')) return value
  } catch { /* Invalid local drafts never replace saved story content. */ }
  return { text: '', files: [] }
}
export function useStoryDraft(storyId: string) {
  const [draft, setDraft] = useState<Draft>(() => stored(storyId)), input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { transferredDrafts.delete(storyId) }, [storyId])
  useEffect(() => { try { sessionStorage.setItem(`rp-draft:${storyId}`, JSON.stringify(draft)) } catch { /* Sending remains available when storage is full. */ } }, [storyId, draft])
  const focusEnd = () => requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(input.current.value.length, input.current.value.length) })
  const suggest = (text: string) => {
    setDraft(value => { const parts = referenceText(value.text); return { ...value, text: withReferences(parts.text.trim() ? parts.text.trimEnd() + '\n' + text : text, parts.ids) } })
    focusEnd()
  }
  return { draft, setDraft, input, focusEnd, suggest }
}

export function composerKeyAction(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing: boolean; keyCode?: number }, touch: boolean, empty: boolean, busyEnter?: 'queue' | 'steer') {
  if (event.isComposing || event.keyCode === 229) return undefined
  if (event.key === 'ArrowUp' && empty && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) return 'restore'
  if (event.key === 'Enter' && !event.shiftKey && !event.altKey && (!touch || event.metaKey || event.ctrlKey)) {
    if (!busyEnter) return 'send'
    if (empty && (event.metaKey || event.ctrlKey)) return 'steer-pending'
    return event.metaKey || event.ctrlKey ? busyEnter === 'queue' ? 'steer' : 'queue' : busyEnter
  }
  return undefined
}

export function editorKeyAction(event: Parameters<typeof composerKeyAction>[0]) {
  if (event.isComposing || event.keyCode === 229) return undefined
  if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return 'cancel'
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) return 'save'
  return undefined
}
