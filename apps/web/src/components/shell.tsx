import { setUiLanguage, uiT, useUiLanguage } from "../lib/i18n.ts"
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { BookOpen, FolderCog, Library, MessageSquareText, PanelLeftClose, Plus, Search, Settings2, SquarePen } from 'lucide-react'
import { useSettings } from '../lib/api.ts'
import { storyDate, useStories } from '../lib/story-list.ts'
import { useMediaQuery } from '../lib/use-media-query.ts'
import { Button, Empty, ErrorNotice, IconButton, Input, Loading, Modal } from './ui.tsx'
import { WorkspaceManager } from './workspaces.tsx'
import { ShellContext } from './shell-context.tsx'
import { SidebarStories } from './sidebar-stories.tsx'
import { DIALOGUE_PALETTE } from '../lib/dialogue-colors.ts'
import { AppBackground } from './app-background.tsx'
import { useStoryDeletionHandler } from './story-deletion-handler.tsx'

export function Shell({ notice }: { notice?: ReactNode }) {
  useUiLanguage()
  useStoryDeletionHandler()
  const searchDestination = useRef<{ messageId: string; storyId: string } | null>(null)
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('rp-sidebar-collapsed') === 'true' } catch { return false } })
  const [drawer, setDrawer] = useState(false), [searching, setSearching] = useState(false), [workspaceOpen, setWorkspaceOpen] = useState(false)
  const mobile = useMediaQuery('(max-width: 800px)'), settings = useSettings()
  const pathname = useRouterState({ select: state => state.location.pathname }), navigate = useNavigate()
  const createStory = (workspace?: string) => {
    setDrawer(false)
    void navigate({ to: '/new', search: { workspace } }).then(() => {
      if (!mobile && window.location.pathname === '/new' && !document.querySelector('[role="dialog"]')) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus({ preventScroll: true }))
    })
  }
  const reading = settings.data?.preferences.reading
  useEffect(() => { if (settings.data) setUiLanguage(settings.data.preferences.language) }, [settings.data?.preferences.language])
  const toggleNavigation = () => {
    if (mobile) { setDrawer(value => !value); return }
    const fromNavigation = document.activeElement?.closest('.sidebar, .navigation-toggle')
    setCollapsed(value => !value)
    if (fromNavigation) requestAnimationFrame(() => document.querySelector<HTMLElement>('.navigation-toggle, .sidebar-slot:not([inert]) .sidebar-collapse')?.focus({ preventScroll: true }))
  }

  useEffect(() => { setDrawer(false); setSearching(false) }, [pathname])
  useEffect(() => { if (!mobile) setDrawer(false) }, [mobile])
  useEffect(() => { try { localStorage.setItem('rp-sidebar-collapsed', String(collapsed)) } catch { /* Layout still works without persistence. */ } }, [collapsed])
  useEffect(() => {
    if (!reading) return
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.documentElement.dataset.theme = reading.theme === 'system' ? media.matches ? 'dark' : 'light' : reading.theme }
    apply(); media.addEventListener('change', apply)
    document.documentElement.style.setProperty('--reading-font', reading.fontFamily === 'serif' ? 'var(--serif)' : 'var(--font-sans)')
    document.documentElement.style.setProperty('--reading-size', `${reading.fontSize}px`)
    document.documentElement.style.setProperty('--reading-leading', String(reading.lineHeight))
    document.documentElement.style.setProperty('--reading-width', `${reading.maxWidth}px`)
    document.documentElement.style.setProperty('--dialogue-light', DIALOGUE_PALETTE[reading.dialogueColor].light)
    document.documentElement.style.setProperty('--dialogue-dark', DIALOGUE_PALETTE[reading.dialogueColor].dark)
    return () => media.removeEventListener('change', apply)
  }, [reading])
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey || document.querySelector('[role="dialog"]')) return
      const key = event.key.toLowerCase()
      if (key === 'b' && !event.shiftKey) { event.preventDefault(); toggleNavigation() }
      if (key === 'k' || key === 'p' && event.shiftKey) { event.preventDefault(); setSearching(true) }
      if (key === 'o' && event.shiftKey) { event.preventDefault(); createStory() }
      if (key === ',') { event.preventDefault(); void navigate({ to: '/settings' }) }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [mobile, navigate])

  const sidebar = <>
    {!mobile && <div className="sidebar-brand"><Link to="/" className="brand" aria-label={uiT("pi-roleplay 全部会话")}><span>pi-roleplay</span></Link><div className="sidebar-brand-actions">
      <IconButton label={uiT('搜索会话')} aria-keyshortcuts="Control+k Meta+k" onClick={() => setSearching(true)}><Search size={18} /></IconButton>
      <IconButton className="sidebar-collapse" label={uiT("收起导航")} aria-keyshortcuts="Control+b Meta+b" onClick={toggleNavigation}><PanelLeftClose size={18} /></IconButton>
    </div></div>}
    <nav className="main-nav" aria-label={uiT("主要导航")}>
      <Button tone="quiet" className={`new-story-button${pathname === '/new' ? ' active' : ''}`} aria-current={pathname === '/new' ? 'page' : undefined} onClick={() => createStory()}><SquarePen size={19} /><span>{uiT("新会话")}</span></Button>
      {mobile && <Button tone="quiet" className="nav-search" onClick={() => { setDrawer(false); setSearching(true) }}><Search size={19} /><span>{uiT("搜索会话")}</span></Button>}
      <Link className="sidebar-all" to="/" onClick={() => setDrawer(false)} activeProps={{ className: 'active', 'aria-current': 'page' }} activeOptions={{ exact: true }}><MessageSquareText size={19} /><span>{uiT('全部会话')}</span></Link>
      <Link to="/library" onClick={() => setDrawer(false)} activeProps={{ className: 'active', 'aria-current': 'page' }}><Library size={19} /><span>{uiT("角色与资料")}</span></Link>
    </nav>
    <SidebarStories done={() => setDrawer(false)} create={createStory} manageWorkspaces={() => setWorkspaceOpen(true)} />
    <nav className="sidebar-footer" aria-label={uiT("应用设置")}>
      <Button tone="quiet" className="sidebar-footer-button" onClick={() => setWorkspaceOpen(true)}><FolderCog size={18} /><span>{uiT("文件工作区")}</span></Button>
      <Link to="/settings" onClick={() => setDrawer(false)} activeProps={{ className: 'active', 'aria-current': 'page' }}><Settings2 size={18} /><span>{uiT("设置")}</span></Link>
    </nav>
  </>

  return <ShellContext.Provider value={{ collapsed, mobile, toggleNavigation, createStory: () => createStory(), searchStories: () => setSearching(true) }}>
    <div className={`app-shell${collapsed ? ' sidebar-collapsed' : ''}`}><AppBackground /><a className="skip-link" href="#main-content">{uiT("跳到正文")}</a>
      {!mobile && <div className="sidebar-slot" aria-hidden={collapsed} inert={collapsed}><aside className="sidebar">{sidebar}</aside></div>}
      <main id="main-content" className="main-content" tabIndex={-1}>{notice}<div className="workspace-content"><Outlet /></div></main>
      <Modal size="form" open={drawer && mobile} onOpenChange={setDrawer} title="pi-roleplay" drawer="left" className="navigation-drawer"><div className="mobile-sidebar">{sidebar}</div></Modal>
      <WorkspaceManager open={workspaceOpen} onOpenChange={setWorkspaceOpen} createStory={createStory} />
      <Modal size="form" open={searching} onOpenChange={setSearching} title={uiT("搜索与跳转")} description={uiT("查找会话名称与历史内容，或开始新会话。")} onCloseAutoFocus={event => { if (searchDestination.current) { event.preventDefault(); window.dispatchEvent(new CustomEvent('rp-reveal-message', { detail: searchDestination.current })); searchDestination.current = null } }}>{searching && <StorySearch done={target => { searchDestination.current = target ?? null; setSearching(false) }} create={() => { setSearching(false); createStory() }} />}</Modal>
    </div>
  </ShellContext.Provider>
}

function StorySearch({ done, create }: { done: (target?: { storyId: string; messageId: string }) => void; create: () => void }) {
  useUiLanguage()
  const [query, setQuery] = useState(''), current = useStories(false, query), archived = useStories(true, query)
  const stories = [...(current.data?.stories ?? []), ...(archived.data?.stories ?? [])]
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-command]')], index = items.indexOf(document.activeElement as HTMLElement)
    const next = index < 0 ? event.key === 'ArrowDown' ? 0 : items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  return <div className="command-search" onKeyDown={move}><div className="search-field"><Search size={18} /><Input autoFocus aria-label={uiT("查找会话")} placeholder={uiT("搜索会话名称或历史内容…")} maxLength={300} value={query} onChange={event => setQuery(event.target.value)} /></div>
    <ErrorNotice error={current.error ?? archived.error} retry={() => { void current.refetch(); void archived.refetch() }} retrying={current.isFetching || archived.isFetching} />
    <div className="command-results">{!query.trim() && <button data-command className="command-result" onClick={create}><Plus size={18} /><span>{uiT("开始新会话")}</span><kbd>⇧ ⌘ O</kbd></button>}
      {current.isPending && <Loading />}{stories.map(story => <Link data-command key={story.id} className="command-result" to="/stories/$storyId" params={{ storyId: story.id }} hash={story.match ? `message-${story.match.messageId}` : undefined} onClick={() => done(story.match ? { storyId: story.id, messageId: story.match.messageId } : undefined)}><BookOpen size={17} /><span><strong>{story.title}</strong>{story.match && <small className="search-excerpt">{story.match.snippet}</small>}</span><small>{story.archived ? uiT("已归档") : storyDate(story.updatedAt)}</small></Link>)}
      {!current.error && !archived.error && !current.isPending && !archived.isPending && !stories.length && <Empty title={uiT("没有找到会话")} action={<Button data-command onClick={create}>{uiT("新会话")}</Button>}>{uiT("试试其他关键词，或从一个新会话开始。")}</Empty>}
    </div><p className="command-hint">{uiT("↑ ↓ 选择 · Enter 打开 · Esc 关闭")}</p>
  </div>
}
