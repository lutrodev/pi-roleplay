import { CancelButton, EditorForm, useDialogGuard } from '../../components/form-guard.tsx'
import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useRouterState } from '@tanstack/react-router'
import { BookOpen, SlidersHorizontal, PanelRight, List, Type, ArrowDown, Archive, Pencil, BookMarked, ScrollText, Activity, MessageSquare, LoaderCircle, WifiOff, Trash2 } from 'lucide-react'
import { api, ApiError, refreshStory, useAction, useSettings, useStory } from '../../lib/api.ts'
import { Button, Empty, ErrorNotice, Field, IconButton, Input, Loading, Menu, MenuItem, MenuSeparator, Modal } from '../../components/ui.tsx'
import { DeleteStoryDialog } from '../../components/delete-story-dialog.tsx'
import { PageHeader } from '../../components/shell-context.tsx'
import { Composer } from './composer.tsx'
import { Message } from './messages.tsx'
import { Questions } from './questions.tsx'
import { ProfileEditor } from './profile.tsx'
import { WritingPromptDialog } from './writing-prompt-dialog.tsx'
import { useReadingHistory } from './history.ts'
import { useStoryDraft } from './draft.ts'
import { useReaderScroll } from './reader-scroll.ts'
import { ReplySuggestions } from './reply-suggestions.tsx'
import { StoryPanel, type StoryPanelTarget } from './panel.tsx'
import { RunFeedback } from './run-feedback.tsx'
import { RunActivity } from './run-activity.tsx'
import { RunProgress } from './run-progress.tsx'
import { RoundProcess } from './process.tsx'
import { roundTraceEntries, RoundTraceLink } from './trace-entry.tsx'
import { TracePanel } from './trace.tsx'
import { initialPanel, preferredPanel, rememberPanel } from './panel-preferences.ts'
import { StorySubagentModels } from './subagent-models.tsx'

import { SummaryFeedback } from './maintenance-feedback.tsx'

export function StoryPage() {
  useUiLanguage()
  const { storyId } = useParams({ from: '/stories/$storyId' })
  return <StoryReader key={storyId} storyId={storyId} />
}
function StoryReader({ storyId }: { storyId: string }) {
  useUiLanguage()
  const [deleting, setDeleting] = useState(false)
  const query = useStory(storyId), settings = useSettings(), action = useAction(), history = useReadingHistory(storyId, query.data), draft = useStoryDraft(storyId)
  const [inspector, setInspector] = useState<StoryPanelTarget | null>(initialPanel), [profile, setProfile] = useState<'basics' | 'models' | null>(null), [writingPrompt, setWritingPrompt] = useState(false), [rename, setRename] = useState(false), [title, setTitle] = useState(''), [editingId, setEditingId] = useState<string | null>(null)
  const [view, setView] = useState<'conversation' | 'trace'>('conversation'), [traceOpened, setTraceOpened] = useState(false), [traceRun, setTraceRun] = useState<string | null>(null)
  const readingCheckpoint = useRef({ top: 0, follow: true })
  const panelGuard = useDialogGuard()
  const chooseInspector = useCallback((next: StoryPanelTarget | null) => panelGuard.context.requestClose(() => { setInspector(next); rememberPanel(next) }), [panelGuard.context.requestClose])
  const closeInspector = useCallback(() => chooseInspector(null), [chooseInspector])
  const summaryRequest = useRef<{ expectedRevision: number; requestId: string } | undefined>(undefined)
  const data = query.data, preferences = settings.data?.preferences, story = data?.story, runs = data?.runs ?? []
  const active = runs.find(run => ['queued', 'running', 'waiting_user'].includes(run.status)), latest = active ?? runs.find(run => run.id === story?.conversationRunId)
  const { scroll, follow, atBottom, jump, onScroll } = useReaderScroll(storyId, !!story && !!preferences, story?.revision)
  const openTrace = (runId?: string) => panelGuard.context.requestClose(() => {
    if (view === 'conversation') readingCheckpoint.current = { top: scroll.current?.scrollTop ?? 0, follow: follow.current }
    follow.current = false; setInspector(null); rememberPanel(null); setTraceRun(runId ?? null); setTraceOpened(true); setView('trace')
  })
  const showConversation = () => { if (view === 'conversation') return; setView('conversation'); requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = readingCheckpoint.current.top; follow.current = readingCheckpoint.current.follow }) }
  const hash = useRouterState({ select: state => state.location.hash }), revealed = useRef(''), [target, setTarget] = useState<string | null>(null)
  const reveal = (messageId: string) => { if (view === 'trace') setView('conversation'); follow.current = false; setTarget(messageId); void history.reveal(messageId) }
  useEffect(() => {
    const requested = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.storyId === storyId) reveal(detail.messageId) }
    window.addEventListener('rp-reveal-message', requested)
    return () => window.removeEventListener('rp-reveal-message', requested)
  }, [storyId, history.reveal, view])
  useEffect(() => {
    if (story && hash.startsWith('message-') && revealed.current !== hash) { revealed.current = hash; reveal(hash.slice(8)) }
  }, [hash, !!story])
  useEffect(() => {
    if (!target) return
    const message = document.getElementById(`message-${target}`)
    if (message) { follow.current = false; message.scrollIntoView({ block: 'start', behavior: 'instant' }); message.focus({ preventScroll: true }); setTarget(null) }
  }, [target, history.messages, follow])
  if (query.isPending || settings.isPending) return <div className="story-page"><PageHeader title={uiT("会话")} /><Loading /></div>
  if (!story || !preferences) return <div className="story-page"><PageHeader title={uiT("会话")} /><div className="page-content conversation-error-page"><ErrorNotice title={uiT('会话暂时无法打开')} error={query.error ?? settings.error} retry={() => { void query.refetch(); void settings.refetch() }} /></div></div>
  const messages = history.messages, summary = story.maintenance.summary
  const busy = !!active || summary?.status === 'running' && summary.trigger === 'manual'
  const traceEntries = roundTraceEntries(messages, latest)
  const committed = !!latest && story.messages.some(message => message.runId === latest.id && (message.kind === 'narrative' || message.kind === 'message') && message.role === 'assistant')
  const activityAnchor = active && messages.findLast(message => message.runId === active.id && message.role === 'user')?.id
  const progress = active && <RunProgress key={active.id} run={active} connection={query.connection} visible={view === 'conversation'} />
  const activity = <RunActivity story={story} run={active ?? latest} activeTools={data.activeTools} connection={query.connection} />
  return <div className="story-page"><div className="story-workspace"><div className="conversation-main">
    <PageHeader title={story.title} detail={story.archived ? uiT("已归档") : undefined} actions={<>
      <StorySubagentModels story={story} disabled={busy || editingId !== null} />
      <Button tone="quiet" className="panel-toggle" aria-label={uiT("对话记录")} aria-expanded={inspector?.tab === "history"} disabled={history.busy || editingId !== null} onClick={() => chooseInspector(inspector?.tab === "history" ? null : { tab: "history" })}><List size={17} /><span>{uiT("对话记录")}</span></Button>
      <Button tone="quiet" className="panel-toggle" aria-label={uiT("会话资料")} aria-expanded={inspector !== null} onClick={() => chooseInspector(inspector ? null : preferredPanel())}><PanelRight size={17} /><span>{uiT("资料")}</span></Button>
      <Button tone="quiet" className="panel-toggle" aria-label={uiT('写作 Prompt')} aria-haspopup="dialog" aria-expanded={writingPrompt} disabled={busy || editingId !== null} onClick={() => setWritingPrompt(true)}><ScrollText size={17} /><span>{uiT('写作 Prompt')}</span></Button>
      <Menu label={uiT("会话操作")}><MenuItem onSelect={() => chooseInspector({ tab: 'reading' })}><Type size={16} />{uiT("阅读与显示")}</MenuItem>
        <MenuItem disabled={busy || editingId !== null} onSelect={() => setProfile('basics')}><SlidersHorizontal size={17} />{uiT('会话设置')}</MenuItem>
        <MenuItem disabled={busy || editingId !== null} onSelect={() => { setTitle(story.title); setRename(true) }}><Pencil size={15} />{uiT("重命名")}</MenuItem>
        <MenuItem disabled={busy || editingId !== null || action.busy} onSelect={() => void action.run(async () => { await api(`/stories/${storyId}/archive`, 'PATCH', { expectedRevision: story.revision, archived: !story.archived }); await refreshStory(storyId) })}><Archive size={15} />{story.archived ? uiT("恢复会话") : uiT("归档会话")}</MenuItem>
        <MenuItem disabled={busy || editingId !== null || story.archived || action.busy} onSelect={() => void action.run(async () => { const request = summaryRequest.current ?? { expectedRevision: story.revision, requestId: crypto.randomUUID() }; summaryRequest.current = request; try { await api(`/stories/${storyId}/summaries`, 'POST', request); summaryRequest.current = undefined; await refreshStory(storyId) } catch (error) { if (!(error instanceof ApiError) || error.status !== 0) summaryRequest.current = undefined; throw error } })}><BookMarked size={15} />{uiT("整理会话总结")}</MenuItem>
        <MenuItem onSelect={() => chooseInspector({ tab: 'summary' })}>{uiT("查看会话总结")}</MenuItem>
        <MenuItem onSelect={() => openTrace()}>{uiT('查看轨迹')}</MenuItem>
        <MenuSeparator />
        <MenuItem danger disabled={busy || editingId !== null || action.busy} onSelect={() => setDeleting(true)}><Trash2 size={16} />{uiT('删除会话')}</MenuItem>
      </Menu>
    </>} />
    <div className="story-view-tabs" role="tablist" aria-label={uiT('会话视图')} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 'conversation' : event.key === 'End' ? 'trace' : view === 'trace' ? 'conversation' : 'trace'
      if (next === 'conversation') showConversation(); else if (view !== 'trace') openTrace(traceRun ?? undefined)
      event.currentTarget.querySelector<HTMLButtonElement>(next === 'trace' ? '#trace-tab' : '#conversation-tab')?.focus()
    }}><button type="button" role="tab" id="conversation-tab" tabIndex={view === 'conversation' ? 0 : -1} aria-selected={view === 'conversation'} aria-controls="conversation-view" onClick={showConversation}><MessageSquare size={15} />{uiT('对话')}</button><button type="button" role="tab" id="trace-tab" tabIndex={view === 'trace' ? 0 : -1} aria-selected={view === 'trace'} aria-controls="trajectory-view" onClick={() => view !== 'trace' && openTrace(traceRun ?? undefined)}><Activity size={15} />{uiT('轨迹')}</button></div>
    <div className="connection-status" role="status">{query.connection !== 'live' && <span className="connection-status-inner">{query.connection === 'reconnecting' ? <WifiOff size={13} aria-hidden="true" /> : <LoaderCircle size={13} className="spinner" aria-hidden="true" />}<span>{query.connection === 'reconnecting' ? uiT("连接中断，正在重新连接；服务端生成仍会继续。") : uiT("正在连接会话…")}</span></span>}</div>
      <div className="conversation-surface" id="conversation-view" role="tabpanel" aria-labelledby="conversation-tab" hidden={view !== 'conversation'}><div className="reader-frame"><div className="reader-scroll" ref={scroll} onScroll={onScroll} role="region" aria-label={uiT("会话内容")} tabIndex={0}>
        <div className="reading-column"><ErrorNotice error={query.error ?? action.error} />
          {story.forkedFrom && <p className="fork-note">{data.forkSourceAvailable === false ? uiT('原会话已删除，此分支的内容和工作区仍保留。') : <><Link to="/stories/$storyId" params={{ storyId: story.forkedFrom.storyId }}>{uiT("从另一个会话展开")}</Link> {uiT(" · 工作文件与原会话共享，修改会同时可见。")}</>}</p>}
          {history.before && <Button className="load-history" disabled={history.busy} onClick={() => { const element = scroll.current, height = element?.scrollHeight ?? 0, top = element?.scrollTop ?? 0; follow.current = false; void history.load().then(() => requestAnimationFrame(() => { if (element) element.scrollTop = top + element.scrollHeight - height })) }}>{history.busy ? uiT("正在读取…") : uiT("阅读更早的消息")}</Button>}<ErrorNotice error={history.error} title={uiT('历史消息暂时无法读取')} />
          {messages.length === 0 && <Empty icon={<BookOpen size={32} strokeWidth={1.3} />} title={uiT("从这里开始")} action={<Button onClick={() => setProfile('basics')}>{uiT("选择角色与资料")}</Button>}>{uiT("输入想法、提出问题，或粘贴一段需要修改的内容。")}</Empty>}
          {messages.map(message => <Fragment key={message.id}>
            <Message message={message} story={{ ...story, messages }} busy={busy || editingId !== null && editingId !== message.id} preferences={preferences} editing={editingId === message.id} onEdit={() => { follow.current = false; setEditingId(message.id) }} onDone={() => setEditingId(null)} showVariables={data?.latestReplyId === message.id && preferences.reading.showStateCard} onVariablesInteract={() => { follow.current = false }} details={traceEntries.messages.has(message.id) &&
              <RoundTraceLink runId={traceEntries.messages.get(message.id)!} inspect={() => openTrace(traceEntries.messages.get(message.id)!)} />
            } overview={traceEntries.messages.has(message.id) && preferences.transcriptView === 'normal' &&
              <RoundProcess runId={traceEntries.messages.get(message.id)!} run={runs.find(run => run.id === message.runId)} />
            } />
            {message.id === activityAnchor && progress}
          </Fragment>)}
          {!activityAnchor && progress}
          <div className="pending-reply">
            {latest && <RunFeedback revision={story.revision} key={latest.id} run={latest} committed={committed} draftPersisted={story.messages.some(message => message.runId === latest.id && message.kind === 'draft')} lastMessage={story.messages.filter(message => message.kind !== 'tool').at(-1)} disabled={busy || editingId !== null || story.archived} highlight={preferences.reading.dialogueHighlight} />}
            {story.questions.filter(question => question.status === 'pending').map(question => <Questions key={question.id} storyId={storyId} question={question} />)}
            {traceEntries.pending && <div className="message-footer run-trace-footer">{activity}<div className="reply-details"><RoundTraceLink runId={traceEntries.pending} inspect={() => openTrace(traceEntries.pending!)} /></div></div>}
          </div>
          <SummaryFeedback summary={summary} disabled={action.busy} inspect={() => chooseInspector({ tab: 'summary' })} stop={() => void action.run(async () => { if (!summary) return; await api(`/stories/${storyId}/summaries/${summary.id}/stop`, 'POST'); await refreshStory(storyId) })} />
          {!traceEntries.pending && activity}
        </div>
      </div>{!atBottom && <Button className="jump-latest" onClick={jump}><ArrowDown size={15} />{uiT("回到最新")}</Button>}</div>
      <Composer story={story} active={active} preferences={preferences} state={draft} openSettings={() => setProfile('models')} onSent={jump} editing={editingId !== null} suggestions={<ReplySuggestions story={story} preferences={preferences} busy={busy} insert={draft.suggest} />} />
      </div>{traceOpened && <div className="trajectory-surface" id="trajectory-view" role="tabpanel" aria-labelledby="trace-tab" hidden={view !== 'trace'}><TracePanel story={story} runs={runs} runId={traceRun} onRunChange={setTraceRun} visible={view === 'trace'} returnToConversation={showConversation} /></div>}
    </div><StoryPanel onTrace={() => openTrace()} target={inspector} choose={chooseInspector} close={closeInspector} guard={panelGuard} story={story} latestReplyId={data?.latestReplyId ?? null} runs={runs} preferences={preferences} historyBusy={history.busy || editingId !== null} onJump={id => { closeInspector(); requestAnimationFrame(() => reveal(id)) }} /></div>
    <Modal open={profile !== null} onOpenChange={open => { if (!open) setProfile(null) }} title={uiT("会话设置")} size="editor">{profile && <ProfileEditor story={story} initialTab={profile} disabled={busy || editingId !== null} done={() => setProfile(null)} />}</Modal>
    <WritingPromptDialog open={writingPrompt} onOpenChange={setWritingPrompt} story={story} disabled={busy || editingId !== null} />
    {deleting && <DeleteStoryDialog storyId={storyId} title={story.title} onClose={() => setDeleting(false)} />}
    <Modal size="compact" open={rename} onOpenChange={setRename} title={uiT("会话名称")}><EditorForm className="stack" dirty={title !== story.title} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => { await api(`/stories/${storyId}/title`, 'PATCH', { expectedRevision: story.revision, title }); setRename(false); await refreshStory(storyId) }) }}><Field label={uiT("名称")}><Input autoFocus required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></Field><ErrorNotice error={action.error} /><div className="form-actions"><CancelButton onCancel={() => setRename(false)} /><Button tone="primary" type="submit" disabled={action.busy}>{uiT("保存")}</Button></div></EditorForm></Modal>
  </div>
}
