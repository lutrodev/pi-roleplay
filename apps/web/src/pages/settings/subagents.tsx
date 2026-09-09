import { StatusNotice } from '../../components/status-notice.tsx'
import { SettingRow, SettingsGroup } from '../../components/settings-layout.tsx'
import { CancelButton, EditorForm } from '../../components/form-guard.tsx'
import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, Pencil, Search } from 'lucide-react'
import type { ModelSelection, SubagentCatalog, TaskSubagent, TaskSubagentInput } from '../../../../../packages/rp-core/src/agents/catalog.ts'
import { api, queryClient, useAction, useModels, useSettings } from '../../lib/api.ts'
import { Button, Empty, ErrorNotice, Field, Input, Loading, Menu, MenuItem, Modal, Textarea } from '../../components/ui.tsx'
import { ModelPicker } from '../../components/selectors.tsx'
import { SettingToggle } from '../../components/settings-controls.tsx'

export function Subagents() {
  useUiLanguage()
  const query = useQuery({ queryKey: ['subagents'], queryFn: () => api<SubagentCatalog>('/settings/subagents') }), action = useAction()
  const [editing, setEditing] = useState<TaskSubagent | 'new' | null>(null), [writer, setWriter] = useState(false), [remove, setRemove] = useState<TaskSubagent | null>(null)
  const [search, setSearch] = useState(''), models = useModels(), preferences = useSettings()
  const refresh = () => Promise.all(['subagents', 'prompt-projection'].map(key => queryClient.invalidateQueries({ queryKey: [key] })))
  if (query.isPending) return <Loading />
  if (!query.data) return <ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />
  const writerRoute = query.data.writer.route.kind === 'fixed' ? query.data.writer.route : null
  const writerModel = models.data?.models.find(model => model.provider === writerRoute?.provider && model.model === writerRoute.model)
  const matches = query.data.subagents.filter(agent => (agent.name + agent.description).toLowerCase().includes(search.toLowerCase()))
  return <div className="settings-form stack subagent-catalog">
    <SettingsGroup><SettingRow label="Writer" help={<>{uiT('始终负责正文写作')}<br />{query.data.writer.route.kind === 'inherit' ? uiT('每次调用跟随所在会话的主模型') : writerModel?.label ?? writerRoute?.model ?? uiT('尚未选择模型')}{writerRoute && (!writerModel || !writerModel.configured) && <> · {uiT('当前不可用')}</>}</>}><Button onClick={() => setWriter(true)}>{uiT('模型设置')}</Button></SettingRow></SettingsGroup>
    {preferences.data && !preferences.data.preferences.subagentsEnabled && <StatusNotice compact tone="paused" title={uiT('任务子代理已暂停')}><p>{uiT('各项配置仍可编辑，重新允许调用后生效；Writer 正常工作。')}</p></StatusNotice>}
    <div className="search-field"><Search size={16} /><Input aria-label={uiT('搜索子代理')} placeholder={uiT('按名称或用途搜索')} value={search} onChange={event => setSearch(event.target.value)} /></div>
    <SettingsGroup title={uiT('任务子代理')} actions={<Button onClick={() => setEditing('new')}><Plus size={15} />{uiT('添加')}</Button>}>
      {matches.map(agent => <SettingToggle key={agent.id} label={agent.name} help={agent.description} checked={agent.enabled} disabled={action.busy} onChange={event => void action.run(async () => { await api(`/settings/subagents/${agent.id}`, 'PATCH', { expectedRevision: agent.revision, enabled: event.target.checked }); await refresh() })} actions={<><Button onClick={() => setEditing(agent)}><Pencil size={15} />{uiT('编辑')}</Button><Menu label={uiT('%{name} 的子代理操作', { name: agent.name })}><MenuItem danger onSelect={() => setRemove(agent)}>{uiT('删除')}</MenuItem></Menu></>} />)}
      {!matches.length && <Empty title={search ? uiT('没有找到子代理') : uiT('按需添加协作角色')} action={search ? <Button onClick={() => setSearch('')}>{uiT('清空搜索')}</Button> : undefined}>{uiT('例如检查剧情连续性、核对设定或润色对话。')}</Empty>}
    </SettingsGroup>
    <ErrorNotice source={!remove && action.error ? 'action' : 'read'} error={(remove ? null : action.error) ?? query.error} />
    <Modal open={editing !== null} onOpenChange={open => { if (!open) setEditing(null) }} title={editing === 'new' ? uiT("创建任务子代理") : uiT("编辑任务子代理")} size="editor" className="settings-modal model-route-dialog model-task-dialog">{editing && <TaskEditor agent={editing === 'new' ? undefined : editing} done={() => { setEditing(null); void refresh() }} />}</Modal>
    <Modal size="form" open={writer} onOpenChange={setWriter} title={uiT("Writer 模型")} className="settings-modal model-route-dialog">{writer && <WriterEditor writer={query.data.writer} done={() => { setWriter(false); void refresh() }} />}</Modal>
    <Modal size="compact" open={remove !== null} onOpenChange={open => { if (!open) setRemove(null) }} title={uiT("删除任务子代理？")}><p>{uiT("删除“")}{remove?.name}{uiT("”后，后续生成将不再使用它。")}</p><ErrorNotice error={action.error} /><div className="form-actions"><Button onClick={() => setRemove(null)}>{uiT("保留")}</Button><Button tone="danger" disabled={action.busy} onClick={() => void action.run(async () => { await api(`/settings/subagents/${remove!.id}`, 'DELETE', { expectedRevision: remove!.revision }); setRemove(null); await refresh() })}>{uiT("删除")}</Button></div></Modal>
  </div>
}
function WriterEditor({ writer, done }: { writer: SubagentCatalog['writer']; done: () => void }) {
  useUiLanguage()
  const [route, setRoute] = useState<ModelSelection>(writer.route), action = useAction()
  return <EditorForm className="stack" dirty={JSON.stringify(route) !== JSON.stringify(writer.route)} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => { await api('/settings/writer', 'PUT', { expectedRevision: writer.revision, route }); done() }) }}><div className="model-route-section"><ModelPicker value={route.kind === 'fixed' ? route : null} inheritLabel={uiT("跟随主模型")} inheritDetail={uiT("每次调用跟随所在会话的主模型")} inheritedReasoning={{ value: route.reasoningEffort, onChange: reasoningEffort => setRoute({ kind: 'inherit', reasoningEffort }) }} onChange={next => setRoute(next ? { kind: 'fixed', ...next } : { kind: 'inherit' })} /></div><ErrorNotice error={action.error} /><div className="form-actions sticky-actions"><CancelButton onCancel={done} /><Button type="submit" tone="primary" disabled={action.busy || JSON.stringify(route) === JSON.stringify(writer.route)}>{uiT("保存 Writer 设置")}</Button></div></EditorForm>
}
function TaskEditor({ agent, done }: { agent?: TaskSubagent; done: () => void }) {
  useUiLanguage()
  const [value, setValue] = useState<TaskSubagentInput>(() => agent ? { name: agent.name, description: agent.description, instructions: agent.instructions, route: agent.route, enabled: agent.enabled, tools: agent.tools } : { name: '', description: '', instructions: '', route: { kind: 'inherit' }, enabled: true, tools: [] }), action = useAction()
  const [baseline] = useState(() => JSON.stringify(value))
  return <EditorForm className="stack task-agent-editor" dirty={JSON.stringify(value) !== baseline} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => { await api(agent ? `/settings/subagents/${agent.id}` : '/settings/subagents', agent ? 'PUT' : 'POST', { ...(agent ? { expectedRevision: agent.revision } : {}), subagent: value }); done() }) }}><div className="task-agent-basics"><Field label={uiT("名称")}><Input autoFocus required maxLength={80} value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} /></Field><SettingToggle label={uiT("启用这个子代理")} checked={value.enabled} onChange={event => setValue({ ...value, enabled: event.target.checked })} /></div><Field label={uiT("调用说明")} help={uiT("告诉主模型在什么情况下使用它，以及与 Writer 或其他子代理的关系。")}><Textarea required maxLength={240} rows={2} value={value.description} onChange={event => setValue({ ...value, description: event.target.value })} /></Field><Field label={uiT("工作指令")}><Textarea required maxLength={20000} rows={4} value={value.instructions} onChange={event => setValue({ ...value, instructions: event.target.value })} /></Field><SettingsGroup layout="form" title={uiT("模型与工具")}><ModelPicker value={value.route.kind === 'fixed' ? value.route : null} inheritLabel={uiT("跟随主模型")} inheritDetail={uiT("每次调用跟随所在会话的主模型")} inheritedReasoning={{ value: value.route.reasoningEffort, onChange: reasoningEffort => setValue({ ...value, route: { kind: 'inherit', reasoningEffort } }) }} onChange={route => setValue({ ...value, route: route ? { kind: 'fixed', ...route } : { kind: 'inherit' } })} /><p className="muted">{uiT("任务子代理默认可读取工作文件和本轮附件。")}</p><div className="task-agent-tools">{(['web_search', 'skill'] as const).map(tool => <SettingToggle key={tool} label={tool === 'web_search' ? uiT("允许网页搜索") : uiT("允许加载 Skills")} checked={value.tools.includes(tool)} onChange={event => setValue({ ...value, tools: event.target.checked ? [...value.tools, tool] : value.tools.filter(item => item !== tool) })} />)}</div></SettingsGroup><ErrorNotice error={action.error} /><div className="form-actions sticky-actions"><CancelButton onCancel={done} /><Button tone="primary" type="submit" disabled={action.busy || !!agent && JSON.stringify(value) === baseline}>{uiT("保存子代理")}</Button></div></EditorForm>
}
