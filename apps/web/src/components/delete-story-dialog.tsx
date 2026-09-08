import { StatusNotice } from './status-notice.tsx'
import { useQuery } from '@tanstack/react-query'
import { api, ApiError, notifyStoryDeleted, useAction, type StoryData } from '../lib/api.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { Button, ErrorNotice, Loading, Modal } from './ui.tsx'
import { EditorForm } from './form-guard.tsx'

export function DeleteStoryDialog({ storyId, title, onClose }: { storyId: string; title: string; onClose: () => void }) {
  useUiLanguage()
  const action = useAction()
  // Freeze the confirmation's revision; a later change requires explicit review again.
  const current = useQuery({ queryKey: ['story-deletion', storyId], queryFn: ({ signal }) => api<StoryData>(`/stories/${storyId}`, 'GET', undefined, signal), staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false })
  const busy = current.data?.runs.some(run => ['queued', 'running', 'waiting_user'].includes(run.status)) || Object.values(current.data?.story.maintenance ?? {}).some(job => job?.status === 'running')
  const changed = action.error instanceof ApiError && action.error.code === 'REVISION_CONFLICT'
  const needsReview = action.error instanceof ApiError && ['REVISION_CONFLICT', 'STORY_BUSY', 'SUMMARY_BUSY', 'STORY_BACKGROUND_BUSY'].includes(action.error.code)
  const remove = () => action.run(async () => {
    if (!current.data) return
    await api(`/stories/${storyId}`, 'DELETE', { expectedRevision: current.data.story.revision })
    onClose(); notifyStoryDeleted(storyId)
  })
  return <Modal size="compact" open onOpenChange={open => { if (!open && !action.busy) onClose() }} title={uiT('删除会话？')} description={uiT('将永久删除「%{title}」的消息、变量和运行记录，无法撤销。', { title: current.data?.story.title ?? title })}>
    <EditorForm className="stack" dirty={false} busy={action.busy} onSubmit={event => { event.preventDefault(); void remove() }}>
      <p className="muted">{uiT('共享资料、工作区文件和其他会话分支会保留。')}</p>
      {current.isFetching && <Loading />}
      {busy && <p role="status">{uiT('会话仍有任务进行中，请等待完成或先停止生成。')}</p>}
      {changed ? <StatusNotice compact tone="error" title={uiT('会话已更新')} details={uiT('会话已更新，请重新确认最新内容后再删除。')} /> : <ErrorNotice error={action.error ?? current.error} />}
      <div className="form-actions"><Button data-autofocus disabled={action.busy} onClick={onClose}>{uiT('取消')}</Button>
        {(needsReview || busy || current.error) && <Button disabled={action.busy || current.isFetching} onClick={() => { action.clear(); void current.refetch() }}>{uiT('重新确认')}</Button>}
        <Button type="submit" tone="danger" disabled={action.busy || current.isFetching || !current.data || !!current.error || !!busy || needsReview}>{action.busy ? uiT('正在删除…') : uiT('删除会话')}</Button>
      </div>
    </EditorForm>
  </Modal>
}
