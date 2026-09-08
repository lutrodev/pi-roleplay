import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'
import { DialogGuardContext, type useDialogGuard } from '../../components/form-guard.tsx'
import { IconButton, surfaceReturnFocus } from '../../components/ui.tsx'
import { uiT } from '../../lib/i18n.ts'

/** A portal leaves navigation and prose geometry intact, with one surface across breakpoints. */
export function InspectorSurface({ open, title, close, guard, children, navigation, viewKey }: {
  open: boolean; title: string; close: () => void; guard: ReturnType<typeof useDialogGuard>; children: ReactNode; navigation?: ReactNode; viewKey?: string
}) {
  const surface = useRef<HTMLElement>(null), closeButton = useRef<HTMLButtonElement>(null), body = useRef<HTMLDivElement>(null), wasOpen = useRef(false)
  const origin = useRef<HTMLElement | null>(null), fallback = useRef<HTMLElement | null>(null)
  // Capture the source before a portal or nested form can claim focus.
  if (open && !wasOpen.current && typeof document !== 'undefined') {
    origin.current = surfaceReturnFocus()
    fallback.current = origin.current?.closest<HTMLElement>('article') ?? document.querySelector<HTMLElement>('.conversation-main .panel-toggle')
  }
  useLayoutEffect(() => { wasOpen.current = open }, [open])
  useLayoutEffect(() => { if (body.current && open) body.current.scrollTop = 0 }, [viewKey, open])
  const visible = useRef({ title, children, navigation })
  if (open) visible.current = { title, children, navigation }
  return <DialogGuardContext.Provider value={guard.context}>
    <Dialog.Root open={open} onOpenChange={next => { if (!next) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content asChild aria-modal aria-describedby={undefined} onOpenAutoFocus={event => { event.preventDefault(); closeButton.current?.focus({ preventScroll: true }) }} onCloseAutoFocus={event => {
          event.preventDefault()
          // A history jump or replacement dialog owns focus if it already moved outside this surface.
          const active = document.activeElement
          if (active && active !== document.body && !surface.current?.contains(active) && active.getClientRects().length) return
          const target = origin.current?.isConnected && origin.current !== document.body ? origin.current : fallback.current
          if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true })
        }}>
          <section ref={surface} className="modal drawer story-inspector">
            <header className="modal-heading inspector-heading"><Dialog.Title>{visible.current.title}</Dialog.Title><Dialog.Close asChild><IconButton ref={closeButton} label={uiT('关闭')} disabled={guard.context.busy}><X size={20} /></IconButton></Dialog.Close></header>
            {visible.current.navigation}
            <div ref={body} className="inspector-body">{visible.current.children}</div>
          </section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {guard.confirmation}
  </DialogGuardContext.Provider>
}
