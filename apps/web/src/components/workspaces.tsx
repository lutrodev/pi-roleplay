import { EditorFooter } from './editor-footer.tsx'
import { CancelButton, EditorForm } from './form-guard.tsx'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FolderOpen, FolderPlus, Pencil, Trash2 } from 'lucide-react'
import type { WorkspaceAccess, WorkspaceRecord } from '../../../../packages/rp-core/src/workspace.ts'
import { api, useAction } from '../lib/api.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { refreshWorkspaces, useWorkspaces, type StoryWorkspace } from '../lib/workspaces.ts'
import { Button, Empty, ErrorNotice, Field, IconButton, Input, Loading, Modal, Select } from './ui.tsx'
import { SettingsGroup } from './settings-layout.tsx'

export function WorkspaceManager({ open, onOpenChange, createStory }: { open: boolean; onOpenChange: (open: boolean) => void; createStory: (workspaceId: string) => void }) {
  useUiLanguage()
  return <Modal size="form" open={open} onOpenChange={onOpenChange} title={uiT('文件工作区')} description={uiT('管理会话使用的共享文件目录与工具权限。角色和世界书在“角色与资料”中管理。')}>{open && <WorkspaceCatalog createStory={id => { onOpenChange(false); createStory(id) }} />}</Modal>
}

function WorkspaceCatalog({ createStory }: { createStory: (workspaceId: string) => void }) {
  const catalog = useWorkspaces(), action = useAction()
  const [edit, setEdit] = useState<WorkspaceRecord | 'new' | null>(null), [remove, setRemove] = useState<WorkspaceRecord | null>(null)
  return <div className="stack"><div className="form-actions"><Button disabled={!catalog.data} onClick={() => setEdit('new')}><FolderPlus size={16} />{uiT('添加工作区')}</Button></div>
    <ErrorNotice source={!remove && action.error ? 'action' : 'read'} error={(remove ? null : action.error) ?? catalog.error} retry={(remove || !action.error) && catalog.error ? () => void catalog.refetch() : undefined} retrying={catalog.isFetching} />{catalog.isPending && <Loading />}
    {!catalog.error && catalog.data?.workspaces.length === 0 && <Empty title={uiT('还没有工作区')}>{uiT('为工作区起个名字，系统会自动创建文件夹。')}</Empty>}
    {catalog.data?.workspaces.map(item => <article className="workspace-card" key={item.id}><FolderOpen size={20} /><div><strong>{item.name}</strong><small>{accessLabel(item.access)}</small></div><div className="workspace-card-actions"><Button tone="quiet" aria-label={uiT('在 %{v0} 中新建会话', { v0: item.name })} onClick={() => createStory(item.id)}>{uiT('新会话')}</Button><IconButton label={uiT('编辑工作区 %{v0}', { v0: item.name })} onClick={() => setEdit(item)}><Pencil size={15} /></IconButton><IconButton label={uiT('移除工作区 %{v0}', { v0: item.name })} onClick={() => setRemove(item)}><Trash2 size={15} /></IconButton></div></article>)}
    <Modal size="form" open={!!edit} onOpenChange={open => { if (!open) setEdit(null) }} title={uiT(edit === 'new' ? '添加工作区' : '编辑工作区')}>{edit && <WorkspaceEditor key={edit === 'new' ? 'new' : edit.id} current={edit === 'new' ? undefined : edit} done={() => setEdit(null)} />}</Modal>
    <Modal size="compact" open={!!remove} onOpenChange={open => { if (!open) setRemove(null) }} title={uiT('移除工作区')}><p>{uiT('仅移除工作区分组。文件、会话和当前读写权限会保留，会话仍可访问原目录。')}</p><p><strong>{remove?.name}</strong></p><ErrorNotice error={action.error} /><div className="form-actions"><Button onClick={() => setRemove(null)}>{uiT('取消')}</Button><Button tone="danger" disabled={action.busy} onClick={() => void action.run(async () => { await api(`/workspaces/${remove!.id}`, 'DELETE', { expectedRevision: remove!.revision }); await refreshWorkspaces(); setRemove(null) })}>{uiT('移除工作区')}</Button></div></Modal>
  </div>
}

export function accessLabel(access: WorkspaceAccess) { return uiT(access === 'read-only' ? '只读' : '可写') }
function AccessSelect({ value, onChange, disabled = false }: { value: WorkspaceAccess; onChange: (value: WorkspaceAccess) => void; disabled?: boolean }) {
  return <Field layout="row" label={uiT('文件权限')} help={uiT('只读时可以浏览、读取和下载文件，Bash 与文件写入会被工具服务拒绝。')}><Select value={value} disabled={disabled} onChange={event => onChange(event.target.value as WorkspaceAccess)}><option value="read-only">{uiT('只读')}</option><option value="read-write">{uiT('可写')}</option></Select></Field>
}
function WorkspaceEditor({ current, done }: { current?: WorkspaceRecord; done: () => void }) {
  const [initialAccess] = useState<WorkspaceAccess>(current?.access ?? 'read-write')
  const [name, setName] = useState(current?.name ?? ''), [access, setAccess] = useState(initialAccess), action = useAction()
  return <EditorForm className="stack" dirty={name !== (current?.name ?? '') || access !== initialAccess} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => {
    await api(current ? `/workspaces/${current.id}` : '/workspaces', current ? 'PUT' : 'POST', current ? { expectedRevision: current.revision, name, access } : { name, access })
    await refreshWorkspaces(); done()
  }) }}>
    <SettingsGroup>
      <Field layout="row" label={uiT('工作区名称')} help={uiT(current ? '重命名只改变显示名称，已有文件路径保持不变。' : '文件夹统一保存在工作区目录中，由系统自动创建。')}><Input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></Field>
      <AccessSelect value={access} onChange={setAccess} />
    </SettingsGroup><EditorFooter error={action.error}><CancelButton onCancel={done} /><Button type="submit" tone="primary" disabled={action.busy || !name.trim()}>{uiT(current ? '保存工作区' : '创建工作区')}</Button></EditorFooter>
  </EditorForm>
}
export function StoryWorkspaceDialog({ storyId, open, onOpenChange }: { storyId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  useUiLanguage()
  return <Modal size="form" open={open} onOpenChange={onOpenChange} title={uiT('会话工作区')} description={uiT('切换工作区会切换文件目录并重置 Bash 环境，原目录文件会保留。')}>{open && <StoryWorkspaceContents storyId={storyId} done={() => onOpenChange(false)} />}</Modal>
}
function StoryWorkspaceContents({ storyId, done }: { storyId: string; done: () => void }) {
  // Fetch the form baseline on each opening; background query refreshes must not discard an edit.
  const current = useQuery({ queryKey: ['workspace-edit', storyId], queryFn: ({ signal }) => api<StoryWorkspace>(`/stories/${storyId}/workspace`, 'GET', undefined, signal), staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }), catalog = useWorkspaces()
  return <><ErrorNotice source="read" error={current.error ?? catalog.error} retry={() => { void current.refetch(); void catalog.refetch() }} />{current.data && catalog.data ? <StoryWorkspaceEditor storyId={storyId} initial={current.data} workspaces={catalog.data.workspaces} done={done} /> : <Loading />}</>
}
function StoryWorkspaceEditor({ storyId, initial, workspaces, done }: { storyId: string; initial: StoryWorkspace; workspaces: WorkspaceRecord[]; done: () => void }) {
  const [workspaceId, setWorkspaceId] = useState(initial.binding.workspaceId ?? ''), [access, setAccess] = useState(initial.binding.access), action = useAction()
  const chosen = workspaces.find(item => item.id === workspaceId)
  const sharedAccess = !!workspaceId || !!initial.binding.workspaceId || workspaces.some(item => item.directory === initial.binding.directory)
  return <EditorForm className="stack" dirty={workspaceId !== (initial.binding.workspaceId ?? '') || access !== initial.binding.access} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => {
    await api(`/stories/${storyId}/workspace`, 'PUT', { expectedRevision: initial.revision, workspaceId: workspaceId || null, ...(!workspaceId ? { access } : {}) })
    await refreshWorkspaces(storyId); done()
  }) }}><SettingsGroup><Field layout="row" label={uiT('关联工作区')} help={<>{uiT('当前目录')}<br /><code>{chosen?.directory ?? initial.binding.directory}</code></>}><Select value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); setAccess(initial.binding.access) }}><option value="">{uiT('不分组，保留当前目录')}</option>{workspaces.map(item => <option value={item.id} key={item.id}>{item.name} · {accessLabel(item.access)}</option>)}</Select></Field>
    <AccessSelect value={chosen?.access ?? access} onChange={setAccess} disabled={sharedAccess} /></SettingsGroup>
    {sharedAccess && <p className="muted">{uiT('共享工作区的权限在工作区管理中修改。')}</p>}<EditorFooter error={action.error}><CancelButton onCancel={done} /><Button tone="primary" type="submit" disabled={action.busy}>{uiT('保存关联')}</Button></EditorFooter>
  </EditorForm>
}
