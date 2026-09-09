import type { ReactNode } from 'react'
import { ErrorNotice } from './ui.tsx'

/** Keep the outcome beside the action, including when a long form is scrolled. */
export function EditorFooter({ error, children }: { error?: Error | null; children?: ReactNode }) {
  if (!error && !children) return null
  return <div className="editor-footer sticky-actions">
    <ErrorNotice error={error} />
    {children && <div className="form-actions">{children}</div>}
  </div>
}
