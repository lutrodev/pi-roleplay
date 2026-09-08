import { ContentImage } from '../../components/content-image.tsx'
import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Check as CheckIcon, Copy, Pencil, Trash2, GitBranch, RotateCcw, File as FileIcon, Download, Info } from 'lucide-react'
import type { FileRecord, StoryMessage, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import type { Preferences } from '../../../../../packages/rp-core/src/settings/preferences.ts'
import { api, refreshStory, useAction, useAsset } from '../../lib/api.ts'
import { Markdown } from '../../components/markdown.tsx'
import { ErrorNotice, Button, IconButton, Menu, MenuItem, Modal } from '../../components/ui.tsx'
import { MessageEditor } from './message-editor.tsx'
import { referenceText } from '../../lib/reference-text.ts'
import { ReferenceChips, referenceCopyText } from '../../components/reference-input.tsx'
import { MessageDetails } from './message-details.tsx'
import { VariablesCard, VariablesToggle } from './variables-card.tsx'

export function Message({ message, story, busy, preferences, editing, onEdit, onDone, details, overview, showVariables = false, onVariablesInteract }: { message: StoryMessage; story: StorySnapshot; busy: boolean; preferences: Preferences; editing: boolean; onEdit: () => void; onDone: () => void; details?: import('react').ReactNode; overview?: import('react').ReactNode; showVariables?: boolean; onVariablesInteract?: () => void }) {
  useUiLanguage()
  const [remove, setRemove] = useState(false), [copied, setCopied] = useState(false), action = useAction(), navigate = useNavigate()
  const [showDetails, setDetails] = useState(false)
  const [variablesExpanded, setVariablesExpanded] = useState(false), variablesBodyId = useId()
  const hasVariables = showVariables && Object.keys(story.state.namespaces).length > 0
  useEffect(() => { if (!hasVariables) setVariablesExpanded(false) }, [hasVariables])
  const content = message.role === 'user' ? referenceText(message.text) : { text: message.text, ids: [] }
  const kind = message.role === 'user' ? 'user-message' : message.kind === 'narrative' || message.kind === 'opening' ? 'narrative-message' : 'discussion-message'
  const avatar = useAsset(message.role === 'user' ? story.profile.resources.persona?.id : story.profile.resources.card?.id)
  const title = message.role === 'user' ? avatar.data?.asset.name ?? uiT("我") : message.kind === 'narrative' || message.kind === 'opening' ? avatar.data?.asset.name ?? 'AI' : message.kind === 'draft' ? uiT("未提交草稿") : uiT("回复")
  const visible = story.messages.filter(item => item.kind !== 'tool')
  const replayable = visible.at(-1)?.id === message.id && message.runId !== null && message.kind !== 'opening'
  const [requestId] = useState(() => crypto.randomUUID())
  const editTrigger = useRef<HTMLButtonElement>(null), copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  const done = () => { onDone(); requestAnimationFrame(() => editTrigger.current?.focus({ preventScroll: true })) }
  return <article className={`story-message ${kind}${editing ? ' message-editing' : ''}`} aria-label={uiT('%{v0}的消息', { v0: title })} id={`message-${message.id}`} data-message-id={message.id} tabIndex={-1}>
    {!editing && message.role !== 'user' && <div className="message-heading"><div className="message-author">{preferences.reading.showAvatars && avatar.data?.asset.avatarFileId && <ContentImage className="avatar" src={`/api/files/${avatar.data.asset.avatarFileId}/content`} alt="" loading="lazy" />}<span>{title}</span>{message.kind === 'opening' && <small className="message-kind">{uiT('开场')}</small>}</div></div>}
    {!editing && message.role === 'user' && preferences.reading.showAvatars && avatar.data?.asset.avatarFileId && <ContentImage className="avatar user-avatar" src={`/api/files/${avatar.data.asset.avatarFileId}/content`} alt={avatar.data.asset.name} loading="lazy" />}
    <div className="message-body">{editing ? <MessageEditor story={story} message={message} replayable={replayable && !story.archived} busy={busy} done={done} /> : <Markdown text={content.text} highlight={preferences.reading.dialogueHighlight} />}</div>
    {!editing && <ReferenceChips ids={content.ids} />}
    {!!message.attachmentIds.length && <div className="message-attachments">{message.attachmentIds.map(id => <Attachment key={id} id={id} />)}</div>}
    {!editing && overview}
    {!editing && <div className="message-footer">
    <div className="message-actions">
      <IconButton label={copied ? uiT("已复制") : uiT("复制消息")} onClick={() => void action.run(async () => { await navigator.clipboard.writeText(message.role === 'user' ? referenceCopyText(message.text) : message.text); setCopied(true); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 2000) })}>{copied ? <CheckIcon size={15} /> : <Copy size={15} />}</IconButton>
      <IconButton ref={editTrigger} label={uiT("编辑消息")} disabled={busy} onClick={onEdit}><Pencil size={15} /></IconButton>
      {replayable && <IconButton label={uiT("重新生成")} disabled={busy || story.archived || action.busy} onClick={() => void action.run(async () => { await api(`/stories/${story.id}/messages/${message.id}/regenerate`, 'POST', { expectedRevision: story.revision, requestId }); await refreshStory(story.id) })}><RotateCcw size={15} /></IconButton>}
      <Menu label={uiT("%{v0}的消息操作", { v0: title })}><MenuItem onSelect={() => setDetails(true)}><Info size={15} />{uiT('消息时间与用量')}</MenuItem>
        <MenuItem disabled={busy || action.busy} onSelect={() => void action.run(async () => { const result = await api<{ story: StorySnapshot }>(`/stories/${story.id}/messages/${message.id}/fork`, 'POST', { expectedRevision: story.revision }); await refreshStory(result.story.id); await navigate({ to: '/stories/$storyId', params: { storyId: result.story.id } }) })}><GitBranch size={15} />{uiT("从这里新建分支")}</MenuItem><MenuItem danger disabled={busy} onSelect={() => setRemove(true)}><Trash2 size={15} />{uiT("删除从这里开始的内容")}</MenuItem></Menu>
    </div>
    {(details || hasVariables) && <div className="reply-details">{hasVariables && <VariablesToggle expanded={variablesExpanded} bodyId={variablesBodyId} onToggle={() => { onVariablesInteract?.(); setVariablesExpanded(value => !value) }} />}{details}</div>}</div>}
    {hasVariables && <VariablesCard storyId={story.id} replyId={message.id} state={story.state} expanded={variablesExpanded && !editing} bodyId={variablesBodyId} onInteract={onVariablesInteract} />}
    <span className="sr-only" role="status">{copied ? uiT("已复制") : ''}</span><ErrorNotice error={action.error} />
    <Modal size="form" open={showDetails} onOpenChange={setDetails} title={uiT("消息时间与用量")}>{showDetails && <MessageDetails message={message} />}</Modal>
    <Modal size="compact" open={remove} onOpenChange={setRemove} title={uiT("删除这段内容？")}><p>{uiT("将删除这条消息及之后的 ")}{Math.max(0, visible.length - visible.findIndex(item => item.id === message.id) - 1)} {uiT(" 条消息，并撤销这些回复带来的变量变化。")}</p><ErrorNotice error={action.error} /><div className="form-actions"><Button onClick={() => setRemove(false)}>{uiT("保留")}</Button><Button tone="danger" disabled={action.busy} onClick={() => void action.run(async () => { await api(`/stories/${story.id}/messages/${message.id}`, 'DELETE', { expectedRevision: story.revision }); setRemove(false); await refreshStory(story.id) })}>{uiT("删除这段内容")}</Button></div></Modal>
  </article>
}
function Attachment({ id }: { id: string }) {
  useUiLanguage()
  const query = useQuery({ queryKey: ['file', id], queryFn: ({ signal }) => api<{ file: FileRecord }>(`/files/${id}`, 'GET', undefined, signal) })
  const file = query.data?.file
  return <div className="attachment">{file?.mimeType.startsWith('image/') && <a href={`/api/files/${id}/content`} target="_blank" rel="noopener noreferrer"><ContentImage src={`/api/files/${id}/content`} alt={file.name} loading="lazy" /></a>}<a href={`/api/files/${id}/content?download=true`}><FileIcon size={16} /><span>{file?.name ?? uiT("附件")}</span><Download size={14} /></a><ErrorNotice error={query.error} /></div>
}
