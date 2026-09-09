import { useFieldValidation } from './field-validation.tsx'
import { uiT, useUiLanguage } from "../lib/i18n.ts"
import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type ChangeEvent, type InputHTMLAttributes, type ReactElement, type ReactNode, type RefObject, type SelectHTMLAttributes } from 'react'
import { Dialog, DropdownMenu, Tabs } from 'radix-ui'
import { Check as CheckIcon, X, Ellipsis, LoaderCircle, RefreshCw } from 'lucide-react'
import { clsx } from 'clsx'
import { errorFeedback } from '../lib/error-feedback.ts'
import { DialogGuardContext, useDialogGuard } from './form-guard.tsx'
import { SettingRow } from './settings-layout.tsx'
import { StatusNotice } from './status-notice.tsx'
import { sameConnectionFailure } from '../lib/api-error.ts'
import { useConnectionFeedback, useSharedConnectionError } from '../lib/connection-feedback.tsx'

export function Button({ children, tone = 'default', className, ...props }: ComponentProps<'button'> & { tone?: 'default' | 'primary' | 'quiet' | 'danger' }) {
  useUiLanguage()
  return <button type="button" className={clsx('button', `button-${tone}`, className)} {...props}>{children}</button>
}
export function IconButton({ label, children, ...props }: ComponentProps<'button'> & { label: string }) {
  useUiLanguage()
  return <Button tone="quiet" aria-label={label} title={label} {...props} className={clsx('icon-button', props.className)}>{children}</Button>
}
export function Field({ label, help, children, layout = 'stack' }: { label: string; help?: ReactNode; children: ReactNode; layout?: 'stack' | 'row' }) {
  useUiLanguage()
  if (layout === 'row') return <SettingRow as="label" kind="field" label={label} help={help}>{children}</SettingRow>
  return <label className="field"><span className="field-copy"><span className="field-label">{label}</span>{help && <span className="field-help">{help}</span>}</span>{children}</label>
}
function boundText(element: HTMLInputElement | HTMLTextAreaElement, maximum?: number) {
  if (maximum !== undefined && maximum >= 0 && [...element.value].length > maximum) element.value = [...element.value].slice(0, maximum).join('')
}
export function Input({ maxLength, onChange, onCompositionEnd, onInvalid, ...props }: ComponentProps<'input'>) {
  useUiLanguage()
  const validation = useFieldValidation()
  return <><input {...props} aria-invalid={validation.error ? true : props['aria-invalid']} aria-describedby={validation.describedBy(props['aria-describedby'])} onInvalid={event => { onInvalid?.(event); validation.invalid(event) }} data-autofocus={props.autoFocus || undefined} data-max-characters={maxLength} className={clsx('input', props.className)} onChange={event => { if (!(event.nativeEvent as InputEvent).isComposing) boundText(event.currentTarget, maxLength); onChange?.(event); validation.changed(event.currentTarget) }} onCompositionEnd={event => { boundText(event.currentTarget, maxLength); onChange?.(event as unknown as ChangeEvent<HTMLInputElement>); onCompositionEnd?.(event); validation.changed(event.currentTarget) }} />{validation.feedback}</>
}
export function TextListInput({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  useUiLanguage()
  const [text, setText] = useState(() => value.join(', '))
  return <Input value={text} onChange={event => { setText(event.target.value); onChange(event.target.value.split(/[,，]/).map(item => item.trim()).filter(Boolean)) }} />
}
// Embedded writing surfaces own their frame and focus treatment instead of inheriting form styles.
export function Textarea({ appearance = 'field', maxLength, onChange, onCompositionEnd, onInvalid, ...props }: ComponentProps<'textarea'> & { appearance?: 'field' | 'plain' }) {
  useUiLanguage()
  const validation = useFieldValidation()
  return <><textarea rows={4} {...props} aria-invalid={validation.error ? true : props['aria-invalid']} aria-describedby={validation.describedBy(props['aria-describedby'])} onInvalid={event => { onInvalid?.(event); validation.invalid(event) }} data-autofocus={props.autoFocus || undefined} data-max-characters={maxLength} className={clsx(appearance === 'field' && 'input textarea', props.className)} onChange={event => { if (!(event.nativeEvent as InputEvent).isComposing) boundText(event.currentTarget, maxLength); onChange?.(event); validation.changed(event.currentTarget) }} onCompositionEnd={event => { boundText(event.currentTarget, maxLength); onChange?.(event as unknown as ChangeEvent<HTMLTextAreaElement>); onCompositionEnd?.(event); validation.changed(event.currentTarget) }} />{validation.feedback}</>
}
export function Select({ onInvalid, onChange, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  useUiLanguage()
  const validation = useFieldValidation()
  return <><select {...props} className={clsx('input select', props.className)} aria-invalid={validation.error ? true : props['aria-invalid']} aria-describedby={validation.describedBy(props['aria-describedby'])} onInvalid={event => { onInvalid?.(event); validation.invalid(event) }} onChange={event => { onChange?.(event); validation.changed(event.currentTarget) }} />{validation.feedback}</>
}
export function Check({ label, help, indeterminate = false, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; help?: string; indeterminate?: boolean }) {
  useUiLanguage()
  return <label className="check"><input type="checkbox" {...props} ref={input => { if (input) input.indeterminate = indeterminate }} /><span>{label}{help && <small>{help}</small>}</span></label>
}
export function ErrorNotice({ error, retry, retrying = false, title, source = 'action' }: { error: Error | null | undefined; retry?: () => void; retrying?: boolean; title?: string; source?: 'read' | 'action' }) {
  useUiLanguage()
  const shared = useSharedConnectionError()
  // A shared outage owns background-read feedback; an explicit operation failure stays at its action.
  if (source === 'read' && sameConnectionFailure(error, shared)) return null
  if (!error) return null
  const feedback = errorFeedback(error)
  return <StatusNotice title={title ?? uiT(feedback.title)} tone="error" compact className="error-notice" details={feedback.details && uiT(feedback.details)} collapseDetails={!!feedback.message} actions={retry && <Button onClick={retry} disabled={retrying}>{retrying ? <LoaderCircle size={14} className="spinner" /> : <RefreshCw size={14} />}{uiT(retrying ? '正在重试…' : '重试')}</Button>}>
    {feedback.message && <p>{uiT(feedback.message)}</p>}{feedback.help && <p>{uiT(feedback.help)}</p>}
  </StatusNotice>
}
export function Loading({ label = uiT("正在读取…") }: { label?: string }) {
  useUiLanguage(); return <div className="loading" role="status"><LoaderCircle size={18} className="spinner" />{label}</div> }
export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  useUiLanguage()
  return <div className="empty-state">{icon && <span className="empty-icon">{icon}</span>}<h2>{title}</h2>{children && <p>{children}</p>}{action}</div>
}

// A controlled dialog opened by a menu has no Dialog.Trigger; retain the durable menu button.
let lastMenuTrigger: HTMLButtonElement | null = null
export function surfaceReturnFocus() {
  const active = document.activeElement as HTMLElement | null
  return (active === document.body || active?.closest('[role="menu"]')) && lastMenuTrigger?.isConnected ? lastMenuTrigger : active
}

export function Modal({ open, onOpenChange, title, description, children, size = 'form', drawer = false, className, returnFocus, onCloseAutoFocus }: {
  open: boolean; onOpenChange: (value: boolean) => void; title: string; description?: string; children: ReactNode; size?: 'compact' | 'form' | 'editor' | 'workspace'; drawer?: boolean | 'left' | 'right'; className?: string; returnFocus?: RefObject<HTMLElement | null>; onCloseAutoFocus?: (event: Event) => void
}) {
  useUiLanguage()
  const connection = useConnectionFeedback()
  const id = useId(), priorFocus = useRef<HTMLElement | null>(null), wasOpen = useRef(false), surface = useRef<HTMLElement>(null)
  const guard = useDialogGuard()
  // Freeze the origin before the portal mounts children with React autoFocus.
  if (open && !wasOpen.current && typeof document !== 'undefined') {
    priorFocus.current = surfaceReturnFocus()
  }
  useLayoutEffect(() => { wasOpen.current = open }, [open])
  // Keep the outgoing surface intact while Radix waits for its CSS exit animation.
  const visible = useRef({ title, description, children, size, drawer, className })
  if (open) visible.current = { title, description, children, size, drawer, className }
  const content = visible.current
  return <DialogGuardContext.Provider value={guard.context}><Dialog.Root open={open} onOpenChange={next => next ? onOpenChange(true) : guard.context.requestClose(() => onOpenChange(false))}><Dialog.Portal><Dialog.Overlay className="overlay" />
    <Dialog.Content asChild aria-describedby={content.description ? id : undefined} onOpenAutoFocus={event => { const target = surface.current?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)'); if (target) { event.preventDefault(); target.focus({ preventScroll: true }) } }} onCloseAutoFocus={event => {
      const target = returnFocus?.current ?? priorFocus.current
      const other = [...document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]')].filter(dialog => dialog !== surface.current).at(-1)
      // A replacement dialog may already be focused while this surface animates out.
      if (other && !other.contains(target)) { event.preventDefault(); if (!other.contains(document.activeElement)) (other.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), button:not(:disabled)') ?? other).focus({ preventScroll: true }); return }
      onCloseAutoFocus?.(event); if (event.defaultPrevented) return
      if (target?.isConnected) { event.preventDefault(); target.focus({ preventScroll: true }) }
    }}>
      <section ref={surface} className={clsx('modal', `modal-${content.size}`, content.drawer && 'drawer', content.drawer === 'left' && 'drawer-left', content.className)}>
        <div className="modal-heading"><div><Dialog.Title>{content.title}</Dialog.Title>{content.description && <Dialog.Description id={id}>{content.description}</Dialog.Description>}</div><Dialog.Close asChild><IconButton label={uiT("关闭")} disabled={guard.context.busy}><X size={20} /></IconButton></Dialog.Close></div>
        {connection.notice && <div className="modal-connection-feedback">{connection.notice}</div>}
        <div className="modal-body">{content.children}</div>
      </section>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>{guard.confirmation}</DialogGuardContext.Provider>
}
export function Menu({ label, children, trigger, open, onOpenChange, onCloseAutoFocus, align = 'end', side, className }: { label: string; children: ReactNode; trigger?: ReactElement; open?: boolean; onOpenChange?: (open: boolean) => void; onCloseAutoFocus?: (event: Event) => void; align?: 'start' | 'center' | 'end'; side?: 'top' | 'right' | 'bottom' | 'left'; className?: string }) {
  useUiLanguage()
  const triggerButton = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => { if (open) lastMenuTrigger = triggerButton.current }, [open])
  return <DropdownMenu.Root open={open} onOpenChange={next => { if (next) lastMenuTrigger = triggerButton.current; onOpenChange?.(next) }}><DropdownMenu.Trigger ref={triggerButton} asChild>{trigger ?? <IconButton label={label}><Ellipsis size={18} /></IconButton>}</DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content onCloseAutoFocus={event => {
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]')].at(-1)
    if (dialog && !dialog.contains(triggerButton.current)) event.preventDefault()
    onCloseAutoFocus?.(event)
  }} aria-label={label} className={clsx('menu', className)} side={side} sideOffset={6} align={align} collisionPadding={12}>{children}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
}
export function MenuItem({ children, danger, className, ...props }: ComponentProps<typeof DropdownMenu.Item> & { danger?: boolean }) {
  useUiLanguage()
  return <DropdownMenu.Item className={clsx('menu-item', danger && 'text-danger', className)} {...props}>{children}</DropdownMenu.Item>
}
export function JsonView({ value }: { value: unknown }) {
  useUiLanguage(); return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre> }

export const MenuRadioGroup = DropdownMenu.RadioGroup
export function MenuRadioItem({ value, children, disabled }: { value: string; children: ReactNode; disabled?: boolean }) {
  useUiLanguage()
  return <DropdownMenu.RadioItem className="menu-item menu-choice" value={value} disabled={disabled}><span className="menu-check"><DropdownMenu.ItemIndicator><CheckIcon size={14} /></DropdownMenu.ItemIndicator></span>{children}</DropdownMenu.RadioItem>
}
export function MenuLabel({ children }: { children: ReactNode }) {
  useUiLanguage(); return <DropdownMenu.Label className="menu-label">{children}</DropdownMenu.Label> }
export function MenuSeparator() {
  useUiLanguage(); return <DropdownMenu.Separator className="menu-separator" /> }

export function TabGroup<T extends string>({ value, onChange, items, label, children, className, orientation = 'horizontal', contentRef }: {
  value: T; onChange: (value: T) => void; items: readonly { value: T; label: string; icon?: ReactNode; disabled?: boolean }[]; label: string; children: ReactNode; className?: string; orientation?: 'horizontal' | 'vertical'; contentRef?: RefObject<HTMLDivElement | null>
}) {
  useUiLanguage()
  return <Tabs.Root value={value} onValueChange={next => onChange(next as T)} className={clsx('tab-group', className)} orientation={orientation}>
    <Tabs.List className="tabs" aria-label={label}>{items.map(item => <Tabs.Trigger className="tab-trigger" value={item.value} disabled={item.disabled} key={item.value}>{item.icon}{item.label}</Tabs.Trigger>)}</Tabs.List>
    <Tabs.Content ref={contentRef} className="tab-content" value={value}>{children}</Tabs.Content>
  </Tabs.Root>
}
