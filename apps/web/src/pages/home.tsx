import { uiT, useUiLanguage } from "../lib/i18n.ts"
import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, BookOpen, Library, Plus, Search, X } from 'lucide-react'
import { storyDate, useStories } from '../lib/story-list.ts'
import { useSidebarSettings } from '../lib/sidebar.ts'
import { StoryActions } from '../components/story-actions.tsx'
import { PageHeader, useShell } from '../components/shell-context.tsx'
import { Button, Empty, ErrorNotice, IconButton, Input, Loading, TabGroup } from '../components/ui.tsx'

export function HomePage() {
  useUiLanguage()
  const [view, setView] = useState<'current' | 'archived'>('current'), [query, setQuery] = useState(''), shell = useShell()
  const catalog = useStories(view === 'archived', query), settings = useSidebarSettings(), stories = catalog.data?.stories ?? [], visible = stories, latest = stories[0]
  return <div className="page-screen"><PageHeader title={uiT("全部会话")} actions={<Button tone="quiet" onClick={shell.createStory}><Plus size={17} /><span>{uiT("新会话")}</span></Button>} />
    <div className="page-content home-page"><div className="page-inner"><div className="page-heading"><h2>{view === 'archived' ? uiT("已归档") : uiT("最近使用")}</h2><p className="muted">{view === 'archived' ? uiT("归档的会话会保留在这里，随时可以恢复。") : uiT("对话、创作、修改，从这里继续。")}</p></div>
      {latest && view === 'current' && !query && <Link className="continue-story" to="/stories/$storyId" params={{ storyId: latest.id }}><span className="continue-icon"><BookOpen size={23} strokeWidth={1.5} /></span><div><strong>{latest.title}</strong><p>{uiT("最近更新 · ")}{storyDate(latest.updatedAt)}</p></div><span className="continue-action">{uiT("继续")}<ArrowRight size={18} /></span></Link>}
      <TabGroup value={view} onChange={setView} label={uiT("会话分类")} items={[{ value: 'current', label: uiT("进行中") }, { value: 'archived', label: uiT("已归档") }]}>
        <div className="list-toolbar"><div className="search-field"><Search size={17} /><Input aria-label={uiT("搜索全部会话")} placeholder={uiT("搜索名称或历史内容…")} maxLength={300} value={query} onChange={event => setQuery(event.target.value)} />{query && <IconButton label={uiT("清空搜索")} onClick={() => setQuery('')}><X size={15} /></IconButton>}</div>{catalog.data && <span className="muted">{visible.length} {uiT(" 个会话")}</span>}</div>
        <ErrorNotice error={catalog.error} retry={() => void catalog.refetch()} retrying={catalog.isFetching} />{catalog.isPending && <Loading label={uiT("正在读取会话…")} />}
        {!!visible.length && <div className="home-story-list"><div className="list-caption"><span>{uiT("会话")}</span><span>{uiT("最近更新")}</span></div>{visible.map(story => <div className="home-story-entry" key={story.id}><Link className="home-story-row" to="/stories/$storyId" params={{ storyId: story.id }} hash={story.match ? `message-${story.match.messageId}` : undefined}><BookOpen size={17} /><span><strong>{story.title}</strong>{story.match && <small className="search-excerpt">{story.match.snippet}</small>}</span><time dateTime={story.updatedAt}>{storyDate(story.updatedAt)}</time><ArrowRight size={16} /></Link><StoryActions story={story} settings={settings.data} /></div>)}</div>}
        {!catalog.error && catalog.data && !visible.length && <Empty icon={<BookOpen size={34} strokeWidth={1.4} />} title={query ? uiT("没有找到会话") : view === 'archived' ? uiT("还没有归档的会话") : uiT("第一个会话，从这里开始")} action={query ? <Button onClick={() => setQuery('')}>{uiT("清空搜索")}</Button> : view === 'current' ? <Button tone="primary" onClick={shell.createStory}><Plus size={17} />{uiT("新会话")}</Button> : undefined}>{query ? uiT("换一个关键词试试。") : view === 'archived' ? uiT("归档的会话会保留在这里，随时可以恢复。") : uiT("可以直接提问、创作或修改内容，也可以带上角色与资料。")}</Empty>}
      </TabGroup>
      <Link className="home-footnote" to="/library"><Library size={17} />{uiT("管理角色与共享资料")}<ArrowRight size={15} /></Link>
    </div></div>
  </div>
}
