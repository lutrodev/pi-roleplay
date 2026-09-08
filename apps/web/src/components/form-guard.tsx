import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { AlertDialog } from 'radix-ui'
import { useBlocker } from '@tanstack/react-router'
import { uiT, useUiLanguage } from '../lib/i18n.ts'

interface FormState { dirty: boolean; busy: boolean }
interface DialogGuard {
  register: (id: string, state: FormState) => () => void
  requestClose: (close: () => void) => void
  busy: boolean
  dirty: boolean
}
export const DialogGuardContext = createContext<DialogGuard | null>(null)

export function useDialogGuard() {
  const forms = useRef(new Map<string, FormState>()), [, changed] = useState(0)
  const [pending, setPending] = useState<(() => void) | null>(null)
  const register = useCallback((id: string, state: FormState) => {
    forms.current.set(id, state); changed(value => value + 1)
    return () => { forms.current.delete(id); changed(value => value + 1) }
  }, [])
  const requestClose = useCallback((close: () => void) => {
    if ([...forms.current.values()].some(form => form.busy)) return
    if ([...forms.current.values()].some(form => form.dirty)) setPending(() => close)
    else close()
  }, [])
  const busy = [...forms.current.values()].some(form => form.busy)
  const dirty = [...forms.current.values()].some(form => form.dirty)
  const context = useMemo(() => ({ register, requestClose, busy, dirty }), [register, requestClose, busy, dirty])
  return { context, confirmation: <DiscardChanges open={!!pending} cancel={() => setPending(null)} discard={() => { const close = pending; setPending(null); close?.() }} /> }
}

function DiscardChanges({ open, cancel, discard }: { open: boolean; cancel: () => void; discard: () => void }) {
  useUiLanguage()
  return <AlertDialog.Root open={open} onOpenChange={next => { if (!next) cancel() }}><AlertDialog.Portal>
    <AlertDialog.Overlay className="overlay discard-overlay" />
    <AlertDialog.Content className="modal discard-dialog">
      <div className="modal-heading"><AlertDialog.Title>{uiT('修改还未保存')}</AlertDialog.Title></div>
      <div className="modal-body stack"><AlertDialog.Description>{uiT('关闭会丢失刚才的修改。你可以继续编辑，或放弃这些修改。')}</AlertDialog.Description>
        <div className="form-actions"><AlertDialog.Action asChild><button type="button" className="button button-danger" onClick={discard}>{uiT('放弃修改')}</button></AlertDialog.Action><AlertDialog.Cancel asChild><button type="button" className="button button-primary">{uiT('继续编辑')}</button></AlertDialog.Cancel></div>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal></AlertDialog.Root>
}

/** Stop portal submissions at their own form and keep pending saves immutable. */
export function EditorForm({ dirty = false, busy = false, children, onSubmit, onInvalidCapture, ...props }: ComponentProps<'form'> & Partial<FormState>) {
  useDialogFormState(dirty, busy)
  const dialog = useContext(DialogGuardContext)
  const blocker = useBlocker({ shouldBlockFn: () => !!dialog?.dirty && !busy, enableBeforeUnload: !!dialog?.dirty && !busy, withResolver: true })
  return <><form {...props} aria-busy={busy || undefined} onInvalidCapture={event => {
    let parent = (event.target as HTMLElement).parentElement
    while (parent && parent !== event.currentTarget) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement }
    onInvalidCapture?.(event)
  }} onSubmit={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onSubmit?.(event) }}>
    <fieldset disabled={busy} className="editor-form-fields">{children}</fieldset>
  </form><DiscardChanges open={blocker.status === 'blocked'} cancel={() => blocker.reset?.()} discard={() => blocker.proceed?.()} /></>
}

/** Include unfinished structured-input drafts in the containing dialog's close guard. */
export function useDialogFormState(dirty: boolean, busy = false) {
  const dialog = useContext(DialogGuardContext), id = useId(), register = dialog?.register
  useLayoutEffect(() => register?.(id, { dirty, busy }), [register, id, dirty, busy])
}

export function CancelButton({ onCancel, children }: { onCancel: () => void; children?: ReactNode }) {
  useUiLanguage()
  const guard = useContext(DialogGuardContext)
  return <button type="button" className="button button-default" disabled={guard?.busy} onClick={() => guard ? guard.requestClose(onCancel) : onCancel()}>{children ?? uiT('取消')}</button>
}
