import { useState } from 'react'
import { ArrowDownUp, ChevronDown, FolderCog } from 'lucide-react'
import type { WorkspaceRecord } from '../../../../packages/rp-core/src/workspace.ts'
import { useAction } from '../lib/api.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { orderedStories, updateSidebar, type SidebarSettings } from '../lib/sidebar.ts'
import { useStories, type StoryListItem } from '../lib/story-list.ts'
import { useWorkspaces } from '../lib/workspaces.ts'
import { CancelButton, EditorForm } from './form-guard.tsx'
import { SortableRows } from './sortable-rows.tsx'
import { Button, ErrorNotice, Loading, Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, Modal } from './ui.tsx'

export function SidebarPreferences({ settings, manageWorkspaces }: { settings: SidebarSettings; manageWorkspaces: () => void }) {
  useUiLanguage()
  const [sortOpen, setSortOpen] = useState(false), action = useAction()
  const label = settings.view === 'workspaces' ? uiT('工作区') : settings.sort === 'manual' ? uiT('会话') : uiT('最近会话')
  return <>
    <div className="sidebar-section-heading"><Menu label={uiT('会话显示选项')} trigger={<Button tone="quiet" className="sidebar-view-button" aria-label={uiT('会话显示选项')} disabled={action.busy}><span>{label}</span><ChevronDown size={13} /></Button>}>
      <MenuLabel>{uiT('会话视图')}</MenuLabel>
      <MenuRadioGroup value={settings.view} onValueChange={view => void action.run(() => updateSidebar(settings, { view: view as SidebarSettings['view'] }))}>
        <MenuRadioItem value="single">{uiT('会话列表')}</MenuRadioItem><MenuRadioItem value="workspaces">{uiT('按工作区')}</MenuRadioItem>
      </MenuRadioGroup><MenuSeparator /><MenuLabel>{uiT('排序方式')}</MenuLabel>
      <MenuRadioGroup value={settings.sort} onValueChange={sort => void action.run(() => updateSidebar(settings, { sort: sort as SidebarSettings['sort'] }))}>
        <MenuRadioItem value="recent">{uiT('最近活动')}</MenuRadioItem><MenuRadioItem value="manual">{uiT('手动顺序')}</MenuRadioItem>
      </MenuRadioGroup><MenuItem onSelect={() => setSortOpen(true)}><ArrowDownUp size={16} />{uiT('调整顺序')}</MenuItem><MenuSeparator />
      <MenuItem onSelect={manageWorkspaces}><FolderCog size={16} />{uiT('管理文件工作区')}</MenuItem>
    </Menu></div><ErrorNotice error={action.error} />
    <Modal size="form" open={sortOpen} onOpenChange={setSortOpen} title={uiT('调整顺序')}>{sortOpen && <SortContents settings={settings} done={() => setSortOpen(false)} />}</Modal>
  </>
}

function SortContents({ settings, done }: { settings: SidebarSettings; done: () => void }) {
  const current = useStories(), archived = useStories(true), workspaces = useWorkspaces()
  return <><ErrorNotice source="read" error={current.error ?? archived.error ?? workspaces.error} retry={() => { void current.refetch(); void archived.refetch(); void workspaces.refetch() }} />
    {current.data && archived.data && workspaces.data ? <SortEditor settings={settings} stories={[...current.data.stories, ...archived.data.stories].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))} workspaces={workspaces.data.workspaces} done={done} /> : <Loading />}
  </>
}
function SortEditor({ settings, stories, workspaces, done }: { settings: SidebarSettings; stories: StoryListItem[]; workspaces: WorkspaceRecord[]; done: () => void }) {
  // Freeze both data and revision while editing; a background refresh cannot erase unsaved order.
  const [initial] = useState(() => ({ settings, stories, workspaces }))
  const [order, setOrder] = useState(() => orderedStories(stories, { sort: 'manual', order: settings.order }).map(story => story.id))
  const [pins, setPins] = useState(settings.pinnedStoryIds)
  const [workspaceOrder, setWorkspaceOrder] = useState(() => [...settings.workspaceOrder.filter(id => workspaces.some(item => item.id === id)), ...workspaces.filter(item => !settings.workspaceOrder.includes(item.id)).map(item => item.id)])
  const [baseline] = useState(() => JSON.stringify({ order, pins, workspaceOrder })), action = useAction()
  return <EditorForm className="stack" dirty={JSON.stringify({ order, pins, workspaceOrder }) !== baseline} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => { await updateSidebar(initial.settings, { sort: 'manual', order, workspaceOrder, pinnedStoryIds: pins }); done() }) }}>
    <p className="muted">{uiT('拖动手柄，或聚焦手柄后使用上下方向键。新会话先显示在顶部，归档不改变手动顺序。')}</p>
    {!!pins.length && <section><h3>{uiT('置顶顺序')}</h3><SortableRows label={uiT('置顶顺序')} rows={pins.map(id => { const story = initial.stories.find(story => story.id === id); return { id, label: story?.title ?? id, badge: story?.archived ? uiT('已归档') : undefined } })} onReorder={setPins} disabled={action.busy} /></section>}
    {initial.settings.view === 'workspaces' && workspaceOrder.length > 0 && <section><h3>{uiT('工作区顺序')}</h3><SortableRows label={uiT('工作区手动顺序')} rows={workspaceOrder.map(id => ({ id, label: initial.workspaces.find(item => item.id === id)!.name }))} onReorder={setWorkspaceOrder} disabled={action.busy} /></section>}
    <section><h3>{uiT('会话顺序')}</h3><SortableRows label={uiT('会话手动顺序')} rows={order.map(id => { const story = initial.stories.find(story => story.id === id)!; return { id, label: story.title, badge: story.archived ? uiT('已归档') : undefined } })} onReorder={setOrder} disabled={action.busy} /></section>
    <p className="muted">{uiT('保存后使用手动顺序；置顶只改变导航位置，不改变会话资料和文件工作区。')}</p><ErrorNotice error={action.error} />
    <div className="form-actions"><CancelButton onCancel={done} /><Button type="submit" tone="primary" disabled={action.busy}>{uiT('保存排序')}</Button></div>
  </EditorForm>
}
