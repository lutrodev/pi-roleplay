import { Popover } from 'radix-ui'
import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Archive, ArrowUp, BookOpen, CornerDownRight, Keyboard, LoaderCircle, Paperclip, Plus, Settings2, ShieldCheck, Sparkles, Square } from 'lucide-react'
import type { MessageInput, RunRecord, StoryProfile, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import type { Preferences } from '../../../../../packages/rp-core/src/settings/preferences.ts'
import { insertQuickReply } from '../../../../../packages/rp-core/src/interaction/quick-replies.js'
import { api, refreshStory, useAction } from '../../lib/api.ts'
import { useMediaQuery } from '../../lib/use-media-query.ts'
import { useAutosizeTextarea } from '../../lib/use-autosize-textarea.ts'
import { ErrorNotice, Button, IconButton, Modal, MenuItem, MenuSeparator } from '../../components/ui.tsx'
import { StatusNotice } from '../../components/status-notice.tsx'
import { ReplyOptionSettings } from './reply-option-settings.tsx'
import { composerKeyAction, type useStoryDraft } from './draft.ts'
import { ComposerControls } from './composer-controls.tsx'
import { InputQueue, steerPending, useInputQueue } from './input-queue.tsx'
import { CompletionPicker, type CompletionChoice, type CompletionControl } from './completion-picker.tsx'
import { completionAt, referenceText, withReferences, type CompletionSpan } from '../../lib/reference-text.ts'
import { ReferenceTextarea, rememberReference } from '../../components/reference-input.tsx'
import { StoryWorkspaceDialog } from '../../components/workspaces.tsx'
import { useStoryWorkspace } from '../../lib/workspaces.ts'
import { ContextUsageDialog } from './context-usage.tsx'
import { composerCommand } from './composer-commands.ts'
import { attachmentLimits, pasteAttachmentText, transferFiles } from './attachment-input.ts'
import { useAttachmentUploads } from './attachment-uploads.ts'
import { ComposerAttachments } from './composer-attachments.tsx'

export type ComposerStory = Pick<StorySnapshot, 'id' | 'revision' | 'profile' | 'messages' | 'archived' | 'maintenance'>
export interface NewSession { submit: (inputs: MessageInput[]) => Promise<void>; changeProfile: (profile: StoryProfile) => void; access: 'read-only' | 'read-write' }

export function Composer({ story, active, preferences, state, openSettings, onSent, editing = false, newSession, suggestions }: {
  story: ComposerStory; newSession?: NewSession; active: RunRecord | undefined; preferences: Preferences; state: ReturnType<typeof useStoryDraft>; openSettings: () => void; onSent: () => void; editing?: boolean; suggestions?: ReactNode
}) {
  useUiLanguage()
  const { draft, setDraft, input } = state, fileInput = useRef<HTMLInputElement>(null), composing = useRef(false), returnToInput = useRef(false), dragDepth = useRef(0)
  const submission = useAction(), stop = useAction(), pending = useRef(draft.request), hintId = useId()
  const upload = useAttachmentUploads(story.id, draft.files, file => setDraft(value => ({ ...value, files: [...value.files, file] })))
  const [access, setAccess] = useState(false), [optionSettings, setOptionSettings] = useState(false), [shortcuts, setShortcuts] = useState(false), [dragging, setDragging] = useState(false)
  const [completion, setCompletion] = useState<CompletionSpan | null>(null), [commandNotice, setCommandNotice] = useState(''), [contextUsage, setContextUsage] = useState(false)
  const completionControl = useRef<CompletionControl>(null), completionId = useId(), [activeOption, setActiveOption] = useState<string>()
  const dismissed = useRef<string | null>(null)
  const touch = useMediaQuery('(pointer: coarse)')
  const workspace = useStoryWorkspace(story.id, !newSession)
  const workspaceAccess = newSession?.access ?? workspace.data?.binding.access
  const accessText = workspaceAccess ? uiT(workspaceAccess === 'read-only' ? '只读工作区' : '可写工作区') : undefined
  const queued = useInputQueue(story.id, !newSession)
  const summaryBusy = story.maintenance.summary?.status === 'running' && story.maintenance.summary.trigger === 'manual'
  const canSteer = active && ['running', 'waiting_user'].includes(active.status)
  const busyMode = canSteer ? preferences.busyEnter : 'queue'
  const canSend = !story.archived && !editing && !submission.busy && !upload.blocked && (!!draft.text.trim() || !!draft.files.length)
  const canAttach = !story.archived && !submission.busy && draft.files.length + upload.items.length < attachmentLimits.count
  useAutosizeTextarea(input, draft.text, 48, 144, .2)
  useEffect(() => { if (!touch && !story.archived && !document.querySelector('[role="dialog"]')) input.current?.focus({ preventScroll: true }) }, [story.id, story.archived, touch, input])

  const changeProfile = (profile: StoryProfile) => {
    if (story.archived || active || editing || summaryBusy || upload.busy) return
    // Share the synchronous submission lock: a mode/model save must finish before a new run can start.
    void submission.run(async () => {
      if (newSession) { newSession.changeProfile(profile); return }
      await api(`/stories/${story.id}/profile`, 'PUT', { expectedRevision: story.revision, profile })
      await refreshStory(story.id)
    })
  }
  const submit = (requested?: 'queue' | 'steer') => {
    if (!canSend) return
    void submission.run(async () => {
      if (newSession) {
        if (composerCommand(draft.text)) throw new Error(uiT('先发送第一条消息，再使用会话指令。'))
        await newSession.submit([{ text: draft.text, attachmentIds: draft.files.map(file => file.id) }]); return
      }
      const command = composerCommand(draft.text)
      if (command) {
        if (draft.files.length) throw new Error(uiT("此指令不接收附件，请先移除附件或改为普通消息。"))
        if (command.argument) throw new Error(uiT("/compact 不接受参数。"))
        const payload = JSON.stringify({ command: command.name }), request = pending.current?.payload === payload ? pending.current : { payload, id: crypto.randomUUID() }
        pending.current = request; setDraft(value => ({ ...value, request }))
        await api(`/stories/${story.id}/summaries`, 'POST', { requestId: request.id, expectedRevision: story.revision })
        pending.current = undefined; setDraft(value => ({ ...value, text: value.text === draft.text ? '' : value.text, request: undefined }))
        setCommandNotice(uiT("已开始整理会话总结，可在总结面板查看进度。"))
        await refreshStory(story.id); input.current?.focus({ preventScroll: true }); return
      }
      setCommandNotice('')
      const mode = requested ?? (active ? busyMode : 'queue')
      if (mode === 'steer' && !canSteer) throw new Error(uiT("当前没有可干预的生成；可以加入待发消息。"))
      const enqueue = !!active || !!queued.items.length || !!summaryBusy || !!requested
      const inputs = [{ text: draft.text, attachmentIds: draft.files.map(file => file.id) }]
      const body = { inputs, ...(enqueue ? { mode, ...(mode === 'steer' ? { targetRunId: active!.id } : {}) } : {}) }, payload = JSON.stringify(body)
      const request = pending.current?.payload === payload ? pending.current : { payload, id: crypto.randomUUID() }
      pending.current = request; setDraft(value => ({ ...value, request }))
      await api(`/stories/${story.id}/${enqueue ? 'input-queue' : 'messages'}`, 'POST', { requestId: request.id, ...body })
      pending.current = undefined
      setDraft(value => ({ text: value.text === draft.text ? '' : value.text, files: value.files.filter(file => !draft.files.some(sent => sent.id === file.id)) }))
      onSent(); await queued.refresh(); input.current?.focus({ preventScroll: true })
    })
  }
  const intake = (files: File[]) => {
    if (!submission.busy && !story.archived) upload.add(files)
  }
  const chooseFiles = () => { returnToInput.current = true; fileInput.current?.click() }
  const restoreInput = (event: Event) => { if (returnToInput.current) { event.preventDefault(); returnToInput.current = false; input.current?.focus({ preventScroll: true }) } }
  const suggestCompletion = (text: string, cursor: number) => {
    const next = completionAt(text, cursor)
    if (!next) dismissed.current = null
    setCompletion(next && dismissed.current !== `${next.kind}:${next.start}` ? next : null)
  }
  const dismissCompletion = () => {
    if (completion) dismissed.current = `${completion.kind}:${completion.start}`
    setCompletion(null)
  }
  const openCompletion = (kind: 'commands' | 'references') => {
    const parts = referenceText(draft.text), cursor = input.current?.selectionStart ?? parts.text.length
    const existing = completionAt(parts.text, cursor)
    dismissed.current = null; returnToInput.current = true
    if (existing?.kind === kind) { setCompletion(existing); return }
    const start = kind === 'commands' ? 0 : cursor
    const trigger = kind === 'commands' ? '/' : `${start && !/\s/u.test(parts.text[start - 1]!) ? ' ' : ''}@`
    const text = parts.text.slice(0, start) + trigger + parts.text.slice(start)
    setDraft(value => ({ ...value, text: withReferences(text, parts.ids) }))
    setCompletion(completionAt(text, start + trigger.length))
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(start + trigger.length, start + trigger.length) })
  }
  const complete = (choice: CompletionChoice, keepOpen = false) => {
    if (!completion) return
    const parts = referenceText(draft.text), before = parts.text.slice(0, completion.start), after = parts.text.slice(completion.end)
    if ('storyId' in choice && !parts.ids.includes(choice.storyId) && parts.ids.length >= 4) {
      setCommandNotice(uiT('每条消息最多引用 4 个会话，请先移除一个引用。')); return
    }
    const inserted = 'text' in choice ? choice.text : ''
    const text = before + inserted + after
    if ('storyId' in choice) rememberReference(choice.storyId, choice.title)
    setDraft(value => ({ ...value, text: withReferences(text, 'storyId' in choice ? [...parts.ids, choice.storyId] : parts.ids) }))
    setCompletion(keepOpen ? completionAt(text, before.length + inserted.length) : null)
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(before.length + inserted.length, before.length + inserted.length) })
  }
  const insert = (reply: Preferences['quickReplies'][number]) => {
    dismissCompletion()
    const parts = referenceText(draft.text)
    const result = insertQuickReply(parts.text, reply.content, { start: input.current?.selectionStart, end: input.current?.selectionEnd }, reply.cursorPosition)
    setDraft(value => ({ ...value, text: withReferences(result.text, parts.ids) }))
    requestAnimationFrame(() => { input.current?.focus({ preventScroll: true }); input.current?.setSelectionRange(result.selection.start, result.selection.end) })
  }
  const status = editing ? uiT("正在编辑消息 · 输入草稿会保留") : active ? active.status === 'queued' ? uiT("正在排队 · 可先写下一条") : active.status === 'waiting_user' ? uiT("请在上方回答问题") : uiT("正在生成 · 可先写下一条") : upload.busy ? uiT("正在上传附件…") : summaryBusy ? uiT("正在整理会话总结 · 可先写下一条") : ''
  return <Popover.Root open={!!completion} onOpenChange={open => { if (!open) dismissCompletion() }}><div className="composer-wrap">
    <ErrorNotice error={submission.error ?? upload.error ?? stop.error} title={uiT('消息操作未完成')} />
    <ErrorNotice source="read" error={queued.error} title={uiT('待发消息暂时无法读取')} retry={() => void queued.refetch()} retrying={queued.isFetching} />
    {commandNotice && <p className="composer-command-notice" role="status">{commandNotice}</p>}
    <InputQueue storyId={story.id} items={queued.items} active={active} disabled={story.archived || editing || submission.busy} refresh={queued.refresh} />
    <div className="composer-surface">{suggestions}
    {story.archived ? <StatusNotice compact icon={Archive} title={uiT('会话已归档')}><p>{uiT('从会话菜单恢复后即可继续。')}</p></StatusNotice> : <Popover.Anchor asChild><form className={`composer${dragging ? ' composer-dragging' : ''}`} onSubmit={event => { event.preventDefault(); submit() }}
      onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; if (!submission.busy) setDragging(true) } }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = submission.busy ? 'none' : 'copy' } }}
      onDragLeave={event => { if (event.dataTransfer.types.includes('Files')) { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false) } }}
      onDrop={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current = 0; setDragging(false); intake(transferFiles(event.dataTransfer)) } }}>
      {dragging && <div className="composer-drop-target"><Paperclip size={20} />{uiT("松开以添加附件")}</div>}
      <div className="composer-input-area">
      <ComposerAttachments files={draft.files} uploads={upload.items} uploadIds={upload.uploadIds} disabled={submission.busy} remove={id => setDraft(value => ({ ...value, files: value.files.filter(item => item.id !== id) }))} cancel={upload.remove} retry={upload.retry} />
      <ReferenceTextarea appearance="plain" className="composer-input" ref={input} rows={1} readOnly={submission.busy} aria-label={uiT("输入消息")} aria-describedby={hintId} placeholder={uiT("接下来，你想怎么做？")} value={draft.text} onValueChange={text => setDraft(value => ({ ...value, text }))} aria-autocomplete="list" aria-controls={completion ? completionId : undefined} aria-activedescendant={completion ? activeOption : undefined} maxLength={200000} onChange={event => {
        const text = event.target.value, cursor = event.target.selectionStart
        if (!composing.current) suggestCompletion(text, cursor)
      }} onSelect={event => { if (composing.current) return; if (event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) setCompletion(null); else if (completion) suggestCompletion(event.currentTarget.value, event.currentTarget.selectionStart) }} onBlur={event => { if (!event.currentTarget.closest('.composer-wrap')?.contains(event.relatedTarget)) dismissCompletion() }}
        onPaste={event => {
          const files = transferFiles(event.clipboardData)
          if (!files.length || submission.busy) return
          event.preventDefault(); intake(files)
          const pasted = event.clipboardData.getData('text/plain')
          if (pasted) {
            const parts = referenceText(draft.text), result = pasteAttachmentText(parts.text, pasted, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)
            setDraft(value => ({ ...value, text: withReferences(result.text, parts.ids) }))
            requestAnimationFrame(() => input.current?.setSelectionRange(result.cursor, result.cursor))
          }
          dismissCompletion()
        }}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={event => { composing.current = false; suggestCompletion(event.currentTarget.value, event.currentTarget.selectionStart) }} onKeyDown={event => {
          if (completion && !event.nativeEvent.isComposing && !composing.current && event.nativeEvent.keyCode !== 229 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissCompletion(); return }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); completionControl.current?.move(event.key === 'ArrowDown' ? 1 : -1); return }
            if (event.key === 'ArrowRight' && event.currentTarget.selectionStart === event.currentTarget.value.length && completionControl.current?.openDirectory()) { event.preventDefault(); return }
            if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) { const chosen = completionControl.current?.choose(); if (chosen || event.key === 'Enter') event.preventDefault(); if (!chosen) dismissCompletion(); return }
          }
          const action = composerKeyAction({ key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, isComposing: event.nativeEvent.isComposing || composing.current, keyCode: event.nativeEvent.keyCode }, touch, !draft.text && !draft.files.length && !upload.blocked, active ? busyMode : undefined)
          if (action === 'send') { event.preventDefault(); submit() }
          if (action === 'queue' || action === 'steer') { event.preventDefault(); submit(action) }
          if (action === 'steer-pending' && canSteer && queued.items.length) { event.preventDefault(); void submission.run(async () => { await steerPending(story.id, active!.id, queued.items); await queued.refresh() }) }
          if (action === 'restore') {
            const previous = story.messages.findLast(message => message.role === 'user')
            if (previous) { event.preventDefault(); setDraft(value => ({ ...value, text: previous.text })); state.focusEnd() }
          }
        }} />
      <span id={hintId} className="sr-only">{touch ? uiT("Enter 换行，轻点箭头发送。") : active ? uiT("Enter %{v0}，Ctrl 或 Command + Enter 使用另一种行为。Shift + Enter 换行。", { v0: busyMode === 'queue' ? uiT("加入待发消息") : uiT("干预当前回复") }) : uiT("Enter 发送，Shift + Enter 换行。空输入框按上方向键恢复上一条输入。")}</span>
      <input ref={fileInput} type="file" multiple hidden onChange={event => { intake(Array.from(event.target.files ?? [])); event.target.value = '' }} />
      </div>
      <ComposerControls story={story} disabled={!!active || editing || summaryBusy || submission.busy || upload.busy} openSettings={openSettings} openContext={newSession ? undefined : () => setContextUsage(true)} onProfileChange={changeProfile}
        menuTrigger={<IconButton label={uiT("添加与快捷操作")} className="composer-add" disabled={submission.busy}>{upload.busy ? <LoaderCircle size={20} className="spinner" /> : <Plus size={20} />}</IconButton>} onMenuCloseAutoFocus={restoreInput}
        menu={<>
          <MenuItem disabled={!canAttach} onSelect={chooseFiles}><Paperclip size={18} /><span>{uiT('文件和图片')}<small className="menu-description">{uiT('选择、拖拽或粘贴附件')}</small></span></MenuItem>
          <MenuItem onSelect={() => openCompletion('commands')}><Sparkles size={18} /><span>{uiT("指令与 Skills")}<small className="menu-description">{uiT('查找快捷指令')}</small></span></MenuItem>
          <MenuItem onSelect={() => openCompletion('references')}><BookOpen size={18} /><span>{newSession ? uiT("引用会话") : uiT("引用文件或会话")}<small className="menu-description">{uiT('添加已有上下文')}</small></span></MenuItem>
          {active && <><MenuSeparator /><MenuItem disabled={!canSend} onSelect={() => submit('queue')}>{uiT("加入待发消息")}</MenuItem><MenuItem disabled={!canSend || !canSteer} onSelect={() => submit('steer')}>{uiT("干预当前回复")}</MenuItem></>}
          <MenuSeparator /><MenuItem onSelect={() => setOptionSettings(true)}><Settings2 size={16} />{uiT("回复选项设置")}</MenuItem>
          {(!newSession || story.profile.runtime.executionMode === 'agent') && <MenuItem onSelect={() => newSession ? openSettings() : setAccess(true)}><ShieldCheck size={16} /><span>{uiT("工具访问范围")}{accessText && <small className="menu-description">{accessText}</small>}</span></MenuItem>}
          <MenuItem onSelect={() => setShortcuts(true)}><Keyboard size={16} />{uiT("键盘快捷键")}</MenuItem>
        </>}
        shortcuts={preferences.quickRepliesEnabled && !!preferences.quickReplies.length && <div className="composer-quick-replies" role="group" aria-label={uiT('快捷输入')}>{preferences.quickReplies.map(reply => <Button key={reply.id} tone="quiet" className="composer-quick-reply" disabled={submission.busy} aria-label={uiT('插入快捷回复：%{v0}', { v0: reply.label })} title={reply.content} onMouseDown={event => { if (event.button === 0) event.preventDefault() }} onClick={() => insert(reply)}>{reply.label}</Button>)}</div>}
        trailing={<><Button type="submit" tone="primary" className="send-button" aria-label={active ? busyMode === 'queue' ? uiT("加入待发消息") : uiT("干预当前回复") : uiT("发送消息")} title={editing ? uiT("完成编辑后即可发送") : active ? busyMode === 'queue' ? uiT("加入待发消息") : uiT("当前工具完成后干预") : uiT("发送消息")} disabled={!canSend} onMouseDown={event => event.preventDefault()}>{submission.busy ? <LoaderCircle size={18} className="spinner" /> : active ? <CornerDownRight size={18} /> : <ArrowUp size={20} />}</Button>{active && <Button className="send-button stop-button" aria-label={uiT("停止生成")} title={uiT("停止生成")} disabled={stop.busy} onMouseDown={event => event.preventDefault()} onClick={() => void stop.run(async () => { await api(`/runs/${active.id}/stop`, 'POST'); await refreshStory(story.id) })}>{stop.busy ? <LoaderCircle size={18} className="spinner" /> : <Square size={14} fill="currentColor" />}</Button>}</>} />
      <div className="sr-only" aria-live="polite">{status}</div>
    </form></Popover.Anchor>}
    </div>
    {completion && <Popover.Portal><Popover.Content className="completion-popover" side="top" align="start" sideOffset={8} collisionPadding={12} aria-label={completion.kind === 'commands' ? uiT('指令与 Skills') : uiT('文件与会话')} onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()} onInteractOutside={event => { if (event.target === input.current) event.preventDefault() }} onMouseDown={event => event.preventDefault()}>
      <CompletionPicker ref={completionControl} kind={completion.kind} query={completion.query} listId={completionId} onActiveChange={setActiveOption} storyId={newSession ? undefined : story.id} agent={story.profile.runtime.executionMode === 'agent'} pick={complete} browse={path => complete({ text: `@${path ? path + '/' : ''}` }, true)} attach={canAttach ? () => { complete({ text: '' }); chooseFiles() } : undefined} />
    </Popover.Content></Popover.Portal>}
    <ContextUsageDialog storyId={story.id} open={contextUsage} onOpenChange={setContextUsage} />
    <Modal size="form" open={optionSettings} onOpenChange={setOptionSettings} title={uiT("回复选项 · 全局设置")}>{optionSettings && <ReplyOptionSettings done={() => setOptionSettings(false)} />}</Modal>
    <StoryWorkspaceDialog storyId={story.id} open={access} onOpenChange={setAccess} />
    <Modal size="form" open={shortcuts} onOpenChange={setShortcuts} title={uiT("键盘快捷键")}><dl className="shortcut-list"><div><dt>{uiT("发送消息")}</dt><dd>Enter / ⌘ / Ctrl + Enter</dd></div><div><dt>{uiT("生成中排队 / 干预")}</dt><dd>{uiT("Enter 按设置执行，⌘ / Ctrl + Enter 使用另一种行为")}</dd></div><div><dt>{uiT("干预全部待发消息")}</dt><dd>{uiT("空输入框 ⌘ / Ctrl + Enter")}</dd></div><div><dt>{uiT("输入换行")}</dt><dd>Shift + Enter</dd></div><div><dt>{uiT("恢复上一条输入")}</dt><dd>{uiT("空输入框 ↑")}</dd></div><div><dt>{uiT("保存行内编辑")}</dt><dd>⌘ / Ctrl + Enter</dd></div><div><dt>{uiT("取消行内编辑 / 关闭浮层")}</dt><dd>Esc</dd></div><div><dt>{uiT("收起导航")}</dt><dd>⌘ / Ctrl + B</dd></div><div><dt>{uiT("搜索会话")}</dt><dd>⌘ / Ctrl + K</dd></div><div><dt>{uiT("新建会话")}</dt><dd>⌘ / Ctrl + Shift + O</dd></div><div><dt>{uiT("选择模型")}</dt><dd>⌘ / Ctrl + Shift + M</dd></div></dl><p className="muted">{uiT("手机 Enter 换行，点击发送按钮提交。中文输入法确认选字不会发送。干预在当前工具完成后进入同一轮，未提交的正文会按新要求重写。")}</p></Modal>
  </div></Popover.Root>
}
