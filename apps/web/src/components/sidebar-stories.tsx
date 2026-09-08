import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { Archive, ChevronDown, CircleAlert, CirclePause, Clock3, Folder, GitBranch, LoaderCircle, MessageCircle, MessageSquareText, Plus, type LucideIcon } from 'lucide-react'
import { api, type StoryData } from '../lib/api.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { sidebarSections, useSidebarSettings, visibleStoryCount, workspaceGroups, type SidebarSettings } from '../lib/sidebar.ts'
import { storyDate, useStories, type StoryListItem } from '../lib/story-list.ts'
import { useWorkspaces } from '../lib/workspaces.ts'
import { Button, ErrorNotice, IconButton, Loading } from './ui.tsx'
import { SidebarPreferences } from './sidebar-preferences.tsx'
import { StoryActions } from './story-actions.tsx'

const pageSize = 40
const statusIcons: Record<string, LucideIcon> = { queued: Clock3, running: LoaderCircle, waiting_user: MessageCircle, failed: CircleAlert, interrupted: CirclePause }
interface RowsProps { stories: StoryListItem[]; settings: SidebarSettings; selectedId?: string; done: () => void; visible?: boolean }

export function SidebarStories({ done, create, manageWorkspaces }: { done: () => void; create: (workspaceId?: string) => void; manageWorkspaces: () => void }) {
  useUiLanguage()
  const catalog = useStories(false, '', 5000), settings = useSidebarSettings()
  const pathname = useRouterState({ select: state => state.location.pathname })
  const selectedId = pathname.startsWith('/stories/') ? pathname.split('/')[2] : undefined
  const selectedListed = catalog.data?.stories.some(story => story.id === selectedId) ?? false
  // An opened archive keeps a labeled entry without replacing the recent conversation list.
  const current = useQuery({ queryKey: ['story', selectedId], enabled: !!selectedId && !!catalog.data && !selectedListed, queryFn: ({ signal }) => api<StoryData>('/stories/' + selectedId, 'GET', undefined, signal) })
  const sections = settings.data && catalog.data ? sidebarSections(catalog.data.stories, settings.data) : null
  const archived = !selectedListed && current.data?.story.archived ? current.data.story : null
  return <>
    <nav className="story-list" aria-label={uiT('会话导航')}>
      <ErrorNotice error={catalog.error ?? settings.error} retry={() => { void catalog.refetch(); void settings.refetch() }} retrying={catalog.isFetching || settings.isFetching} />
      {(catalog.isPending || settings.isPending) && <Loading label={uiT('读取会话…')} />}
      {sections && settings.data && <>
        {archived && <section className="sidebar-section" aria-label={uiT('当前归档会话')}><div className="sidebar-section-heading">{uiT('当前归档会话')}</div><SidebarStory story={archived} settings={settings.data} done={done} /></section>}
        {sections.pinned.length > 0 && <section className="sidebar-section" aria-label={uiT('置顶会话')}><div className="sidebar-section-heading">{uiT('置顶')}</div><StoryRows stories={sections.pinned} settings={settings.data} selectedId={selectedId} done={done} /></section>}
        <section className="sidebar-section" aria-label={uiT('会话列表')}>
          <SidebarPreferences settings={settings.data} manageWorkspaces={manageWorkspaces} />
          {settings.data.view === 'workspaces' ? <WorkspaceStories stories={sections.regular} settings={settings.data} selectedId={selectedId} done={done} create={create} /> : <StoryRows stories={sections.regular} settings={settings.data} selectedId={selectedId} done={done} />}
          {catalog.data?.stories.length === 0 && <p className="sidebar-hint">{uiT('新会话会出现在这里')}</p>}
        </section>
      </>}
    </nav>
  </>
}

function WorkspaceStories({ stories, settings, selectedId, done, create }: RowsProps & { create: (workspaceId?: string) => void }) {
  const catalog = useWorkspaces()
  const [collapsed, setCollapsed] = useState<string[]>(() => { try { const saved = JSON.parse(localStorage.getItem('rp-collapsed-workspaces') ?? '[]'); return Array.isArray(saved) && saved.every(id => typeof id === 'string') ? saved : [] } catch { return [] } })
  const activeGroup = stories.find(story => story.id === selectedId)?.workspaceId ?? ''
  const containsSelected = stories.some(story => story.id === selectedId)
  const missingWorkspaces = catalog.data ? [...new Set(stories.map(story => story.workspaceId).filter(id => id && !catalog.data.workspaces.some(workspace => workspace.id === id)))].sort().join(',') : ''
  useEffect(() => { if (missingWorkspaces) void catalog.refetch() }, [missingWorkspaces, catalog.refetch])
  useEffect(() => { if (containsSelected) setCollapsed(ids => ids.filter(id => id !== activeGroup)) }, [selectedId, activeGroup, containsSelected])
  useEffect(() => { try { localStorage.setItem('rp-collapsed-workspaces', JSON.stringify(collapsed)) } catch { /* The in-memory choice remains usable without local storage. */ } }, [collapsed])
  const groups = catalog.data ? workspaceGroups(stories, catalog.data.workspaces, settings) : []
  return <><ErrorNotice error={catalog.error} retry={() => void catalog.refetch()} retrying={catalog.isFetching} />{catalog.isPending && <Loading />}
    {groups.map(group => {
      const open = !collapsed.includes(group.id), label = group.id ? group.name || uiT('工作区信息待刷新') : uiT('独立会话')
      return <section className="sidebar-workspace" key={group.id}>
        <div className="sidebar-workspace-heading"><button title={label} aria-expanded={open} aria-controls={'workspace-group-' + (group.id || 'none')} onClick={() => setCollapsed(ids => open ? [...ids, group.id] : ids.filter(id => id !== group.id))}>{group.id ? <Folder size={18} /> : <MessageSquareText size={18} />}<span>{label}</span><ChevronDown className="sidebar-workspace-chevron" size={12} /></button>
          {group.id && group.name && <IconButton label={uiT('在 %{v0} 中新建会话', { v0: label })} onClick={() => create(group.id)}><Plus size={15} /></IconButton>}
        </div>
        <div className="sidebar-workspace-rows" id={'workspace-group-' + (group.id || 'none')} hidden={!open}><StoryRows stories={group.stories} settings={settings} selectedId={selectedId} done={done} visible={open} /></div>
      </section>
    })}
  </>
}

function StoryRows({ stories, settings, selectedId, done, visible = true }: RowsProps) {
  const [requested, setRequested] = useState(pageSize), list = useRef<HTMLDivElement>(null), revealed = useRef<string | undefined>(undefined)
  const count = visibleStoryCount(stories, requested, selectedId), containsSelected = stories.some(story => story.id === selectedId)
  useEffect(() => {
    if (!visible || !containsSelected || !selectedId || revealed.current === selectedId) return
    const frame = requestAnimationFrame(() => {
      const selected = list.current?.querySelector<HTMLElement>('a.active'), scroller = list.current?.closest<HTMLElement>('.story-list')
      if (!selected || !scroller || !selected.getClientRects().length) return
      const bounds = scroller.getBoundingClientRect(), row = selected.getBoundingClientRect()
      if (row.bottom > bounds.bottom - 8) scroller.scrollTop += row.bottom - bounds.bottom + 8
      else if (row.top < bounds.top + 8) scroller.scrollTop += row.top - bounds.top - 8
      revealed.current = selectedId
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedId, containsSelected, visible])
  return <div ref={list}>{stories.slice(0, count).map(story => <SidebarStory key={story.id} story={story} settings={settings} done={done} />)}
    {stories.length > count && <Button tone="quiet" className="sidebar-more" onClick={() => setRequested(count + pageSize)}>{uiT('显示更多会话')}</Button>}
  </div>
}

export function SidebarStory({ story, settings, done }: { story: StoryListItem; settings: SidebarSettings; done: () => void }) {
  useUiLanguage()
  const status = ({ queued: uiT('排队中'), running: uiT('生成中'), waiting_user: uiT('待回答'), failed: uiT('失败'), interrupted: uiT('已中断') } as Record<string, string>)[story.status ?? '']
  const StatusIcon = story.archived ? Archive : statusIcons[story.status ?? '']
  const description = story.archived ? uiT('已归档') : status ?? storyDate(story.updatedAt)
  return <div className="sidebar-story">
    <Link onClick={done} to="/stories/$storyId" params={{ storyId: story.id }} title={`${story.title}\n${description}`} activeProps={{ className: 'active', 'aria-current': 'page' }}>
      {story.parentStoryId && <GitBranch size={13} aria-label={uiT('分支会话')} />}
      <span className="sidebar-story-title">{story.title}</span>
      {StatusIcon ? <small className="sidebar-story-state" data-status={story.archived ? 'archived' : story.status ?? undefined} title={description}><StatusIcon size={14} className={!story.archived && story.status === 'running' ? 'spinner' : undefined} aria-hidden="true" /><span className="sr-only">{description}</span></small> : <span className="sr-only">{description}</span>}
    </Link>
    <StoryActions story={story} settings={settings} />
  </div>
}
