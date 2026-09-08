import { useImperativeHandle, useRef, type ComponentProps } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, X } from 'lucide-react'
import { api, queryClient } from '../lib/api.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { referenceText, withReferences } from '../lib/reference-text.ts'
import { IconButton, Textarea } from './ui.tsx'

type ReferenceStory = { story: { title: string } }
export function rememberReference(id: string, title: string) {
  queryClient.setQueryData(['reference-name', id], { story: { title } })
}
export function referenceCopyText(value: string) {
  const { text, ids } = referenceText(value)
  return text + (ids.length ? '\n\n' + ids.map(id => `@${queryClient.getQueryData<ReferenceStory>(['reference-name', id])?.story.title ?? uiT('引用会话')}`).join(' ') : '')
}

export function ReferenceChips({ ids, remove, disabled }: { ids: readonly string[]; remove?: (id: string) => void; disabled?: boolean }) {
  if (!ids.length) return null
  return <div className="reference-chips" aria-label={uiT('引用会话')}>{ids.map(id => <ReferenceChip key={id} id={id} disabled={disabled} remove={remove && (() => remove(id))} />)}</div>
}
function ReferenceChip({ id, remove, disabled }: { id: string; remove?: () => void; disabled?: boolean }) {
  useUiLanguage()
  const query = useQuery({ queryKey: ['reference-name', id], staleTime: 60000, retry: false, queryFn: ({ signal }) => api<ReferenceStory>(`/stories/${id}`, 'GET', undefined, signal) })
  const title = query.data?.story.title ?? (query.error ? uiT('引用会话不可用') : uiT('引用会话'))
  return <span className="reference-chip"><BookOpen size={14} /><a href={`/stories/${id}`} target="_blank" rel="noopener noreferrer" title={uiT('查看引用：%{name}（新标签页）', { name: title })}>{title}</a>{remove && <IconButton label={uiT('移除引用：%{name}', { name: title })} disabled={disabled} onClick={remove}><X size={13} /></IconButton>}</span>
}

/** All writing surfaces share readable references, while storage and generation keep stable IDs. */
export function ReferenceTextarea({ value, onValueChange, onChange, resolveReferences = true, ref, ...props }: Omit<ComponentProps<typeof Textarea>, 'value'> & { value: string; onValueChange: (text: string) => void; resolveReferences?: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(ref, () => input.current!, [])
  const parts = resolveReferences ? referenceText(value) : { text: value, ids: [] }
  return <><ReferenceChips ids={parts.ids} disabled={props.disabled || props.readOnly} remove={id => { onValueChange(withReferences(parts.text, parts.ids.filter(item => item !== id))); input.current?.focus({ preventScroll: true }) }} />
    <Textarea {...props} ref={input} value={parts.text} onChange={event => { onValueChange(withReferences(event.target.value, parts.ids)); onChange?.(event) }} />
  </>
}
