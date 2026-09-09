import { useId, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { CircleAlert, Clock3, FileQuestion, LoaderCircle, LockKeyhole, RefreshCw, Settings2, WifiOff, type LucideIcon } from 'lucide-react'
import { errorFeedback, stalePageModule } from '../lib/error-feedback.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { StatusDetails, StatusNotice } from './status-notice.tsx'
import { Button } from './ui.tsx'

const errorIcons = { connection: WifiOff, error: CircleAlert, locked: LockKeyhole, clock: Clock3, missing: FileQuestion }

export function PageFeedback({ title, description, icon: Icon, details, actions, busy = false }: {
  title: string; description: string; icon: LucideIcon; details?: string; actions?: ReactNode; busy?: boolean
}) {
  const id = useId()
  return <section className="page-feedback" aria-labelledby={id}>
    <div className="page-feedback-copy" role={busy ? 'status' : 'alert'} aria-atomic="true">
      <span className="page-feedback-icon"><Icon size={24} className={busy ? 'spinner' : undefined} aria-hidden="true" /></span>
      <h1 id={id}>{title}</h1><p>{description}</p>
    </div>
    {details && <StatusDetails text={details} />}
    {actions && <div className="page-feedback-actions">{actions}</div>}
  </section>
}

export function EntryState({ error, configured, busy, retry, offline = false }: { error?: Error | null; configured?: boolean; busy: boolean; retry: () => void; offline?: boolean }) {
  useUiLanguage()
  const feedback = error ? errorFeedback(error) : undefined
  return <main className="entry-page"><p className="entry-brand">pi-roleplay</p>
    {feedback ? <PageFeedback title={uiT(feedback.title)} description={uiT(feedback.message ?? '暂时无法打开创作空间，请重试连接。')} icon={errorIcons[feedback.icon]} details={feedback.details && uiT(feedback.details)} actions={<Button tone="primary" onClick={retry} disabled={busy || offline}>{busy && !offline ? <LoaderCircle size={15} className="spinner" /> : <RefreshCw size={15} />}{uiT(offline ? '等待网络恢复' : busy ? '正在重试…' : '重试连接')}</Button>} />
      : configured === false ? <PageFeedback title={uiT('完成首次设置')} description={uiT('管理员密码尚未设置。请在服务器上完成初始化，然后重新检查。')} icon={Settings2} actions={<Button tone="primary" onClick={retry} disabled={busy}>{busy && <LoaderCircle size={15} className="spinner" />}{uiT(busy ? '正在检查…' : '重新检查')}</Button>} />
      : <PageFeedback title={uiT('正在连接创作空间')} description={uiT('正在检查服务和登录状态…')} icon={LoaderCircle} busy />}
  </main>
}

export function WorkspaceConnectionNotice({ error, busy, retry, offline = false }: { error: Error; busy: boolean; retry: () => void; offline?: boolean }) {
  useUiLanguage()
  const feedback = errorFeedback(error)
  return <StatusNotice title={uiT(feedback.title)} tone="warning" icon={errorIcons[feedback.icon]} compact className="workspace-connection-notice" details={feedback.details && uiT(feedback.details)} collapseDetails actions={<Button onClick={retry} disabled={busy || offline}>{busy && !offline ? <LoaderCircle size={14} className="spinner" /> : <RefreshCw size={14} />}{uiT(offline ? '等待网络恢复' : busy ? '正在重试…' : '重试连接')}</Button>}>
    <p>{uiT('内容与未保存的编辑仍保留，恢复后自动同步。')}</p>
  </StatusNotice>
}

export function PageLoadError({ error, reset }: { error: Error; reset: () => void }) {
  useUiLanguage()
  const staleModule = stalePageModule(error)
  // A rejected lazy import retains its failed bundle; it needs a fresh document.
  return <div className="page-recovery"><PageFeedback title={uiT('这个页面暂时无法打开')} description={uiT(staleModule ? '页面资源可能已更新，或加载时连接中断。重新加载后再试。' : '页面遇到了问题，请重试打开。')} icon={CircleAlert} details={error.message} actions={<><Button tone="primary" onClick={staleModule ? () => location.reload() : reset}><RefreshCw size={15} />{uiT(staleModule ? '重新加载页面' : '重试打开')}</Button><Link to="/" className="button button-quiet">{uiT('回到首页')}</Link></>} /></div>
}

export function MissingPage() {
  useUiLanguage()
  return <div className="page-recovery"><PageFeedback title={uiT('这一页不存在')} description={uiT('链接可能已失效，或页面地址不完整。')} icon={FileQuestion} actions={<Link to="/" className="button button-primary">{uiT('回到首页')}</Link>} /></div>
}
