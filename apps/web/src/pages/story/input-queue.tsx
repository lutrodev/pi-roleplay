
import { CancelButton, EditorForm } from '../../components/form-guard.tsx'
import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CornerDownRight, Pencil, Trash2, X } from 'lucide-react'
import type { FileRecord, MessageInput, PendingInput, RunRecord } from '../../../../../packages/rp-core/src/types.ts'
import { api, queryClient, refreshStory, useAction } from '../../lib/api.ts'
import { ErrorNotice, Button, Field, IconButton, Modal, Textarea } from '../../components/ui.tsx'

import { ReferenceChips, ReferenceTextarea } from '../../components/reference-input.tsx'
import { referenceText } from '../../lib/reference-text.ts'

export function useInputQueue(storyId: string, enabled = true) {
  const query = useQuery({ enabled, queryKey: ['input-queue', storyId], queryFn: () => api<{ items: PendingInput[] }>(`/stories/${storyId}/input-queue`) })
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['input-queue', storyId] }), refreshStory(storyId)])
  return { ...query, items: query.data?.items ?? [], refresh }
}
export async function steerPending(storyId: string, targetRunId: string, items: PendingInput[]) {
  await api(`/stories/${storyId}/input-queue/steer`, 'POST', { targetRunId, items: items.map(({ id, revision }) => ({ id, revision })) })
  await queryClient.invalidateQueries({ queryKey: ['input-queue', storyId] })
}
export function InputQueue({ storyId, active, items, disabled, refresh }: { storyId: string; active?: RunRecord; items: PendingInput[]; disabled: boolean; refresh: () => Promise<unknown> }) {
  useUiLanguage()
  const action = useAction(), [editing, setEditing] = useState<PendingInput | null>(null)
  const canSteer = active && ['running', 'waiting_user'].includes(active.status)
  const blocked = disabled || action.busy
  if (!items.length && !action.error && !editing) return null
  return <section className="input-queue" aria-label={uiT("待发消息")}><div className="section-heading"><strong>{uiT("待发消息 · ")}{items.length}</strong>{items.length > 1 && <Button tone="quiet" disabled={blocked || !canSteer} onClick={() => void action.run(async () => { await steerPending(storyId, active!.id, items); await refresh() })}>{uiT("全部干预")}</Button>}</div>
    {items.map((item, index) => <div className="input-queue-item" key={item.id}><div><span className="muted">{index + 1} · {item.mode === 'steer' ? uiT("等待当前工具完成后生效") : uiT("当前回复结束后发送")}</span><p>{item.inputs.map(input => referenceText(input.text).text).join('\n') || uiT("附件消息")}</p><ReferenceChips ids={[...new Set(item.inputs.flatMap(input => referenceText(input.text).ids))]} />{[...new Set(item.inputs.flatMap(input => input.attachmentIds))].map(id => <QueuedFile key={id} id={id} />)}</div><div className="input-queue-actions"><IconButton label={uiT("编辑待发消息 %{v0}", { v0: index + 1 })} disabled={blocked} onClick={() => setEditing(item)}><Pencil size={15} /></IconButton><IconButton label={uiT("用待发消息 %{v0} 干预", { v0: index + 1 })} disabled={blocked || !canSteer || item.mode === 'steer'} onClick={() => void action.run(async () => { await api(`/stories/${storyId}/input-queue/${item.id}`, 'PUT', { expectedRevision: item.revision, inputs: item.inputs, mode: 'steer', targetRunId: active!.id }); await refresh() })}><CornerDownRight size={16} /></IconButton><IconButton label={uiT("移除待发消息 %{v0}", { v0: index + 1 })} disabled={blocked} onClick={() => void action.run(async () => { await api(`/stories/${storyId}/input-queue/${item.id}`, 'DELETE', { expectedRevision: item.revision }); await refresh() })}><Trash2 size={15} /></IconButton></div></div>)}
    <ErrorNotice error={action.error} />
    <Modal size="form" open={editing !== null} onOpenChange={open => { if (!open) setEditing(null) }} title={uiT("编辑待发消息")}>{editing && <QueueEditor key={editing.id} item={editing} done={() => { setEditing(null); void refresh() }} />}</Modal>
  </section>
}
function QueuedFile({ id, remove }: { id: string; remove?: () => void }) {
  useUiLanguage()
  const query = useQuery({ queryKey: ['file', id], queryFn: () => api<{ file: FileRecord }>(`/files/${id}`) })
  return <span className="queued-file"><a href={`/api/files/${id}/content?download=true`}>{query.data?.file.name ?? uiT("附件")}</a>{remove && <IconButton label={uiT("移除待发附件")} onClick={remove}><X size={13} /></IconButton>}</span>
}
function QueueEditor({ item, done }: { item: PendingInput; done: () => void }) {
  useUiLanguage()
  const [inputs, setInputs] = useState<MessageInput[]>(() => structuredClone(item.inputs)), action = useAction()
  return <EditorForm className="stack" dirty={JSON.stringify(inputs) !== JSON.stringify(item.inputs)} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => { await api(`/stories/${item.storyId}/input-queue/${item.id}`, 'PUT', { expectedRevision: item.revision, inputs, mode: item.mode, ...(item.targetRunId ? { targetRunId: item.targetRunId } : {}) }); done() }) }}>
    {inputs.map((input, index) => <div className="stack" key={index}><Field label={inputs.length === 1 ? uiT("消息正文") : uiT("消息正文 %{v0}", { v0: index + 1 })}><ReferenceTextarea autoFocus={index === 0} rows={5} maxLength={200000} value={input.text} onValueChange={text => setInputs(inputs.map((item, i) => i === index ? { ...item, text } : item))} /></Field>{input.attachmentIds.map(id => <QueuedFile key={id} id={id} remove={() => setInputs(inputs.map((item, i) => i === index ? { ...item, attachmentIds: item.attachmentIds.filter(file => file !== id) } : item))} />)}</div>)}
    <ErrorNotice error={action.error} /><div className="form-actions"><CancelButton onCancel={done} /><Button type="submit" tone="primary" disabled={action.busy || inputs.some(input => !input.text.trim() && !input.attachmentIds.length)}>{uiT("保存待发消息")}</Button></div>
  </EditorForm>
}
