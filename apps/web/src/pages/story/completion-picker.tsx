
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { useEffect, useImperativeHandle, useState, type Ref } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookMarked, BookOpen, ChevronRight, File, Folder, Paperclip, Sparkles } from 'lucide-react'
import { fileMention } from '../../../../../packages/rp-core/src/interaction/references.ts'
import { api } from '../../lib/api.ts'
import { useStories } from '../../lib/story-list.ts'
import { ErrorNotice, Loading } from '../../components/ui.tsx'

export type CompletionChoice = { text: string } | { storyId: string; title: string }
export interface CompletionControl { move: (direction: number) => void; choose: () => boolean; openDirectory: () => boolean }

export function CompletionPicker({ kind, storyId, agent, query, listId, pick, browse, attach, onActiveChange, ref }: {
  kind: 'commands' | 'references'; storyId?: string; agent: boolean; query: string; listId: string
  pick: (choice: CompletionChoice) => void; browse: (path: string) => void
  attach?: () => void
  onActiveChange: (id: string | undefined) => void; ref: Ref<CompletionControl>
}) {
  useUiLanguage()
  const [active, setActive] = useState(0)
  const slash = query.lastIndexOf('/'), path = slash >= 0 ? query.slice(0, slash) || '.' : '.'
  const needle = query.slice(slash + 1).trim().toLocaleLowerCase()
  const skills = useQuery({ queryKey: ['skills'], enabled: kind === 'commands' && agent, queryFn: () => api<{ skills: { name: string; description: string; enabled: boolean; userInvocable: boolean }[] }>('/settings/skills') })
  const listing = useQuery({ queryKey: ['workspace', storyId, path], enabled: kind === 'references' && !!storyId, queryFn: ({ signal }) => api<{ entries: { name: string; kind: string }[]; truncated: boolean }>(`/stories/${storyId}/files?path=${encodeURIComponent(path)}`, 'GET', undefined, signal) })
  const current = useStories(false, kind === 'references' ? query.slice(0, 300) : ''), archived = useStories(true, kind === 'references' ? query.slice(0, 300) : '')
  const commands = [...(storyId ? [{ name: 'compact', label: uiT('整理总结'), description: uiT('压缩上下文，保留原始对话'), icon: BookMarked }] : []),
    ...(agent ? skills.data?.skills.filter(skill => skill.enabled && skill.userInvocable).map(skill => ({ ...skill, label: skill.name, icon: Sparkles })) ?? [] : [])]
    .filter(item => `${item.name} ${item.label} ${item.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const entries = listing.data?.entries.filter(entry => entry.name.toLocaleLowerCase().includes(needle)) ?? []
  const stories = [...(current.data?.stories ?? []), ...(archived.data?.stories ?? [])].filter(story => story.id !== storyId && story.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const files = entries.flatMap(entry => {
    const location = path === '.' ? entry.name : `${path}/${entry.name}`, mention = fileMention(location, entry.kind === 'directory')
    return !mention || entry.kind === 'symlink' ? [] : [{ key: `file:${location}`, label: entry.name + (entry.kind === 'directory' ? '/' : ''), description: '', icon: entry.kind === 'directory' ? Folder : File, select: () => pick({ text: mention + ' ' }), directory: entry.kind === 'directory' ? location : undefined }]
  })
  const items = kind === 'commands'
    ? commands.map(command => ({ key: command.name, label: command.label, description: command.description, icon: command.icon, select: () => pick({ text: `/${command.name} ` }), directory: undefined }))
    : [...(attach && !query.trim() ? [{ key: 'attach', label: uiT('文件和图片'), description: uiT('添加本地附件'), icon: Paperclip, select: attach, directory: undefined }] : []),
      ...files, ...stories.map(story => ({ key: `story:${story.id}`, label: story.title, description: story.archived ? uiT('已归档会话') : uiT('会话'), icon: BookOpen, select: () => pick({ storyId: story.id, title: story.title }), directory: undefined }))]
  const index = Math.min(active, Math.max(0, items.length - 1)), selected = items[index]
  useEffect(() => { setActive(0) }, [kind, query])
  useEffect(() => { onActiveChange(selected ? `${listId}-${index}` : undefined) }, [selected?.key, index, listId, onActiveChange])
  useEffect(() => { document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' }) }, [index, listId])
  useImperativeHandle(ref, () => ({
    move: direction => { if (items.length) setActive((index + direction + items.length) % items.length) },
    choose: () => { if (!selected) return false; selected.select(); return true },
    openDirectory: () => { if (!selected?.directory) return false; browse(selected.directory); return true },
  }))
  return <div className="completion-picker">
    {kind === 'references' && slash >= 0 && <button type="button" className="completion-parent" onMouseDown={event => event.preventDefault()} onClick={() => browse(path.split('/').slice(0, -1).join('/'))}>{uiT('上层')} · {path}</button>}
    <div role="listbox" id={listId} aria-describedby={`${listId}-hint`} aria-label={kind === 'commands' ? uiT('指令与 Skills') : storyId ? uiT('文件与会话') : uiT('引用会话')}>
      {items.map((item, i) => <div className="completion-row" key={item.key}>
        <button type="button" tabIndex={-1} role="option" aria-selected={i === index} id={`${listId}-${i}`} className="completion-choice" title={[item.label, item.description].filter(Boolean).join(' · ')} onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(i)} onClick={item.select}><item.icon size={18} aria-hidden="true" /><span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span></button>
        {item.directory && <button type="button" tabIndex={-1} className="completion-directory" aria-label={uiT('打开目录 %{v0}', { v0: item.label })} onMouseDown={event => event.preventDefault()} onClick={() => browse(item.directory!)}><ChevronRight size={16} /></button>}
      </div>)}
    </div>
    {kind === 'references' && listing.isFetching && <Loading />}
    {!items.length && !(kind === 'references' && (listing.isFetching || current.isFetching || archived.isFetching)) && <p className="muted">{uiT('没有匹配的选项')}</p>}
    <ErrorNotice source="read" error={kind === 'commands' ? skills.error : listing.error ?? current.error ?? archived.error} />
    {kind === 'references' && listing.data?.truncated && <p className="muted">{uiT('目录条目较多，请输入子目录继续查找。')}</p>}
    <div className="sr-only" id={`${listId}-hint`}>{selected?.directory ? uiT('↑ ↓ 选择 · → 打开目录 · Enter 引用') : uiT('↑ ↓ 选择 · Enter 插入 · Esc 关闭')}</div>
  </div>
}
