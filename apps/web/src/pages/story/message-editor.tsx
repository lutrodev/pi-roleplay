
import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useRef, useState } from 'react'
import { useBlocker } from '@tanstack/react-router'
import type { StoryMessage, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import { api, refreshStory, useAction } from '../../lib/api.ts'
import { useAutosizeTextarea } from '../../lib/use-autosize-textarea.ts'
import { ErrorNotice, Button, Menu, MenuItem, Modal } from '../../components/ui.tsx'
import { ReferenceTextarea } from '../../components/reference-input.tsx'
import { editorKeyAction } from './draft.ts'

export function MessageEditor({ story, message, replayable, busy, done }: { story: StorySnapshot; message: StoryMessage; replayable: boolean; busy: boolean; done: () => void }) {
  useUiLanguage()
  const [text, setText] = useState(message.text), [revision] = useState(story.revision), pending = useRef({ text: message.text, id: crypto.randomUUID() }), action = useAction()
  const input = useRef<HTMLTextAreaElement>(null), composing = useRef(false), saved = useRef(false)
  useAutosizeTextarea(input, text, 56, 360, .45)
  const resends = replayable && message.role === 'user', disabled = busy || action.busy || !text.trim()
  const blocker = useBlocker({ shouldBlockFn: () => !saved.current && text !== message.text, enableBeforeUnload: !saved.current && text !== message.text, withResolver: true })
  const save = (regenerate = resends) => {
    if (disabled) return
    void action.run(async () => {
      if (pending.current.text !== text) pending.current = { text, id: crypto.randomUUID() }
      await api(`/stories/${story.id}/messages/${message.id}${regenerate ? '/regenerate' : ''}`, regenerate ? 'POST' : 'PATCH', { expectedRevision: revision, ...(regenerate ? { requestId: pending.current.id, editedText: text } : { text }) })
      saved.current = true
      await refreshStory(story.id); done()
    })
  }
  return <><form className="message-editor" aria-label={uiT("编辑消息")} onSubmit={event => { event.preventDefault(); save() }}>
    <ReferenceTextarea appearance="plain" className="message-editor-input" resolveReferences={message.role === 'user'} ref={input} autoFocus required maxLength={200000} rows={2} aria-label={uiT("编辑消息内容")} readOnly={action.busy} value={text} onValueChange={setText}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
        const intent = editorKeyAction({ key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, isComposing: composing.current || event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })
        if (intent === 'cancel' && !action.busy) { event.preventDefault(); done() }
        if (intent === 'save') { event.preventDefault(); save() }
      }} />
    <ErrorNotice error={action.error} />
    <div className="message-editor-actions">
      {replayable && <Menu label={uiT("其他保存方式")}><MenuItem disabled={disabled} onSelect={() => save(!resends)}>{resends ? uiT("仅保存文字") : uiT("保存并重新生成")}</MenuItem></Menu>}
      <span className="sr-only">{resends ? uiT("发送将使用修改后的内容重新生成。") : uiT("保存只更新这条消息的文字。")}{uiT("⌘ 或 Ctrl + Enter 保存，Esc 取消。")}</span>
      <Button className="editor-cancel" disabled={action.busy} onClick={done}>{uiT("取消")}</Button>
      <Button tone="primary" type="submit" disabled={disabled}>{action.busy ? uiT("保存中…") : resends ? uiT("发送") : uiT("保存")}</Button>
    </div>
  </form><Modal size="compact" open={blocker.status === 'blocked'} onOpenChange={open => { if (!open) blocker.reset?.() }} title={uiT("消息还未保存")} returnFocus={input}><p>{uiT("离开会丢失这条消息的修改，原文会保留。")}</p><div className="form-actions"><Button onClick={() => blocker.proceed?.()}>{uiT("放弃修改并离开")}</Button><Button tone="primary" onClick={() => blocker.reset?.()}>{uiT("继续编辑")}</Button></div></Modal></>
}
