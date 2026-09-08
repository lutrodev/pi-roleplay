import type { ReactNode } from 'react'
import { CheckCircle2, ChevronRight, CircleAlert, CirclePause, Info, LoaderCircle, type LucideIcon } from 'lucide-react'
import { uiT, useUiLanguage } from '../lib/i18n.ts'

type NoticeTone = 'info' | 'error' | 'paused' | 'busy' | 'success'
const icons: Record<NoticeTone, LucideIcon> = { info: Info, error: CircleAlert, paused: CirclePause, busy: LoaderCircle, success: CheckCircle2 }

/** Shared feedback for fields, panels and conversation states. */
export function StatusNotice({ title, tone = 'info', icon, children, details, collapseDetails = false, actions, compact = false, className = '' }: {
  title: string; tone?: NoticeTone; icon?: LucideIcon; children?: ReactNode; details?: string; collapseDetails?: boolean; actions?: ReactNode; compact?: boolean; className?: string
}) {
  useUiLanguage()
  const Icon = icon ?? icons[tone], longDetails = !!details && (collapseDetails || details.length > 240 || details.split('\n').length > 3)
  return <section className={`status-notice${compact ? ' status-notice-compact' : ''} ${className}`} data-tone={tone} aria-label={title}>
    <div className="status-notice-copy" role={tone === 'error' ? 'alert' : 'status'} aria-atomic="true">
      <Icon className={`status-notice-icon${tone === 'busy' ? ' spinner' : ''}`} size={16} aria-hidden="true" />
      <div className="status-notice-text"><h3>{title}</h3>{children}{details && !longDetails && <p className="status-notice-reason">{details}</p>}</div>
    </div>
    {longDetails && <StatusDetails text={details!} />}
    {actions && <div className="status-notice-actions">{actions}</div>}
  </section>
}

export function StatusDetails({ text }: { text: string }) {
  useUiLanguage()
  return <details className="status-notice-details"><summary><ChevronRight size={12} aria-hidden="true" />{uiT('查看详细原因')}</summary><p>{text}</p></details>
}
