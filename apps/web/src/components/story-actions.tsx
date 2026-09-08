import { useRef, useState } from 'react'
import { Archive, ArchiveRestore, ExternalLink, FolderCog, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { api, refreshStory, useAction, type StoryData } from '../lib/api.ts'
import { pinStory, type SidebarSettings } from '../lib/sidebar.ts'
import type { StoryListItem } from '../lib/story-list.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { Button, ErrorNotice, Field, IconButton, Input, Menu, MenuItem, MenuSeparator, Modal } from './ui.tsx'
import { CancelButton, EditorForm } from './form-guard.tsx'
import { StoryWorkspaceDialog } from './workspaces.tsx'
import { DeleteStoryDialog } from './delete-story-dialog.tsx'

export function StoryActions({ story, settings }: { story: StoryListItem; settings?: SidebarSettings }) {
  const [deleting, setDeleting] = useState(false)
  useUiLanguage()
  const [rename, setRename] = useState(false), [workspace, setWorkspace] = useState(false), [title, setTitle] = useState(story.title), action = useAction()
  const busy = ['queued', 'running', 'waiting_user'].includes(story.status ?? '')
  const pinned = settings?.pinnedStoryIds.includes(story.id) ?? false
  const trigger = useRef<HTMLButtonElement>(null)
  const relocate = async (operation: () => Promise<unknown>) => {
    const source = trigger.current, region = source?.closest('.story-list, .home-story-list'), surface = source?.closest('.sidebar, .mobile-sidebar, .page-screen')
    try { await operation() } finally {
      requestAnimationFrame(() => {
        // A pin/archive can replace this row. Restore keyboard position without taking focus from another control.
        if (document.activeElement !== document.body && document.activeElement !== source) return
        const replacement = region?.querySelector<HTMLButtonElement>(`[data-story-actions="${CSS.escape(story.id)}"]`)
        const fallback = surface?.querySelector<HTMLElement>('.sidebar-all, input[aria-label]')
        const target = replacement?.isConnected ? replacement : fallback
        target?.focus({ preventScroll: true })
        if (target && region instanceof HTMLElement && region.classList.contains('story-list')) {
          const row = target.getBoundingClientRect(), bounds = region.getBoundingClientRect()
          if (row.bottom > bounds.bottom - 8) region.scrollTop += row.bottom - bounds.bottom + 8
          else if (row.top < bounds.top + 8) region.scrollTop += row.top - bounds.top - 8
        }
      })
    }
  }
  const update = async (kind: 'title' | 'archive') => {
    const current = await api<StoryData>(`/stories/${story.id}`)
    await api(`/stories/${story.id}/${kind}`, 'PATCH', { expectedRevision: current.story.revision, ...(kind === 'title' ? { title } : { archived: !story.archived }) })
    await refreshStory(story.id); setRename(false)
  }
  return <>
    <Menu label={uiT('%{v0} 的操作', { v0: story.title })} trigger={<IconButton ref={trigger} data-story-actions={story.id} className="story-actions-trigger" label={uiT('%{v0} 的操作', { v0: story.title })}><MoreHorizontal size={16} /></IconButton>}>
      <MenuItem disabled={!settings || action.busy} onSelect={() => void action.run(() => relocate(() => pinStory(settings!, story.id, !pinned)))}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}{pinned ? uiT('取消置顶') : uiT('置顶会话')}</MenuItem>
      <MenuItem disabled={busy || action.busy} onSelect={() => { action.clear(); setTitle(story.title); setRename(true) }}><Pencil size={16} />{uiT('重命名会话')}</MenuItem>
      <MenuItem disabled={busy || action.busy} onSelect={() => setWorkspace(true)}><FolderCog size={16} />{uiT('会话工作区')}</MenuItem>
      <MenuSeparator />
      <MenuItem disabled={busy || action.busy} onSelect={() => void action.run(() => relocate(() => update('archive')))}>{story.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}{story.archived ? uiT('恢复会话') : uiT('归档会话')}</MenuItem>
      <MenuItem onSelect={() => window.open(`/stories/${story.id}`, '_blank', 'noopener,noreferrer')}><ExternalLink size={16} />{uiT('在新标签页打开')}</MenuItem>
      <MenuSeparator />
      <MenuItem danger disabled={busy || action.busy} onSelect={() => setDeleting(true)}><Trash2 size={16} />{uiT('删除会话')}</MenuItem>
    </Menu>
    {action.error && !rename && <div className="story-action-error"><ErrorNotice error={action.error} /></div>}
    <Modal size="compact" open={rename} onOpenChange={setRename} title={uiT('重命名会话')}><EditorForm className="stack" dirty={title !== story.title} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(() => update('title')) }}>
      <Field label={uiT('会话名称')}><Input autoFocus maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></Field><ErrorNotice error={action.error} />
      <div className="form-actions"><CancelButton onCancel={() => setRename(false)} /><Button type="submit" tone="primary" disabled={action.busy || !title.trim()}>{uiT('保存名称')}</Button></div>
    </EditorForm></Modal>
    {workspace && <StoryWorkspaceDialog storyId={story.id} open={workspace} onOpenChange={setWorkspace} />}
    {deleting && <DeleteStoryDialog storyId={story.id} title={story.title} onClose={() => setDeleting(false)} />}
  </>
}
