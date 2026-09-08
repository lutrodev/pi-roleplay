import { useRef } from 'react'
import { LoaderCircle, RotateCcw } from 'lucide-react'
import type { RunRecord, StoryMessage } from '../../../../../packages/rp-core/src/types.ts'
import { api, refreshStory, useAction } from '../../lib/api.ts'
import { ErrorNotice, Button } from '../../components/ui.tsx'
import { StatusNotice } from '../../components/status-notice.tsx'
import { Markdown } from '../../components/markdown.tsx'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'

export function RunFeedback({ run, committed, draftPersisted, lastMessage, disabled, highlight, revision }: {
  run: RunRecord; committed: boolean; draftPersisted: boolean; lastMessage?: StoryMessage; disabled: boolean; highlight: boolean; revision: number
}) {
  useUiLanguage()
  const action = useAction(), requestId = useRef(crypto.randomUUID())
  const active = ['queued', 'running', 'waiting_user'].includes(run.status), failed = ['failed', 'interrupted'].includes(run.status), stopped = run.status === 'cancelled'
  const hasDraft = !committed && (!!run.draft || draftPersisted), draft = hasDraft && !!run.draft && !draftPersisted && run.status !== 'completed'
  if (!active && !failed && !stopped) return null
  if (active && !draft) return null
  const retryable = !committed && lastMessage?.runId === run.id && lastMessage.kind !== 'opening' && !active
  if (active) return <section className="run-feedback run-preview" aria-label={uiT('回复预览')}>
    <div className="run-feedback-heading"><span>{uiT('回复预览')}</span></div>
    <div className="draft-message"><Markdown text={run.draft} highlight={highlight} /></div>
  </section>
  const title = committed ? stopped ? uiT('已停止后续处理') : uiT('后续处理未完成') : stopped ? uiT('已停止生成') : run.status === 'interrupted' ? uiT('生成已中断') : uiT('生成未完成')
  const description = committed ? stopped ? uiT('已停止后续过程，保存的回复仍然保留。') : uiT('回复已保存，后续过程未完成。')
    : hasDraft ? uiT('草稿已保留，尚未提交为正文。') : stopped ? uiT('已停止生成，可以修改输入后继续。') : retryable ? uiT('可以重新生成，或调整输入后继续。') : uiT('可以调整输入后继续。')
  return <section className="run-feedback" aria-label={uiT('生成状态')}>
    {draft && <div className="run-feedback-heading"><span>{uiT('草稿尚未提交')}</span></div>}
    {draft && <div className="draft-message"><Markdown text={run.draft} highlight={highlight} /></div>}
    <StatusNotice title={title} tone={run.status === 'failed' ? 'error' : 'paused'} details={failed && run.error ? uiT(run.error.message) : undefined} actions={retryable &&
      <Button className="retry-generation" disabled={disabled || action.busy} onClick={() => void action.run(async () => { await api(`/stories/${run.storyId}/messages/${lastMessage.id}/regenerate`, 'POST', { expectedRevision: revision, requestId: requestId.current }); await refreshStory(run.storyId) })}>{action.busy ? <LoaderCircle size={14} className="spinner" /> : <RotateCcw size={14} />}{action.busy ? uiT('正在重试…') : uiT('重新生成')}</Button>
    }><p>{description}</p></StatusNotice>
    <ErrorNotice error={action.error} title={uiT('未能重新生成')} />
  </section>
}
