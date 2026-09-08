import { uiT, uiLocale, useUiLanguage } from "../../lib/i18n.ts"
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Preferences } from '../../../../../packages/rp-core/src/settings/preferences.ts'
import type { PromptRole, SystemPromptSection } from '../../../../../packages/rp-core/src/context/system-prompt.ts'
import { api } from '../../lib/api.ts'
import { ErrorNotice, Field, JsonView, Loading, Select, Textarea } from '../../components/ui.tsx'
import { SettingsGroup } from '../../components/settings-layout.tsx'

interface Projection { roles: { id: string; label: string; role: PromptRole; model: { provider: string; model: string } | null; sections: SystemPromptSection[]; enabled?: boolean; optionalTools?: string[] }[]; diagnostics: unknown[] }
const deliveries: Record<PromptRole, string[]> = {
  chat: ['系统提示：统一身份、RP 事实规则、Chat 工作流程、本轮会话设定。', '用户消息：会话总结、历史消息、角色卡与人设、本轮输入和附件清单；写作素材由 Writer 接收。', '工具：正文写作、剧情提交、创作讨论回复、资料与变量读取、附件只读工具。'],
  agent: ['系统提示：统一身份、RP 事实规则、Agent 工作流程、启用的 Skills 目录及用户直接调用的指导、本轮会话设定。', '用户消息：按 Prompt 排序的完整资料、本轮输入、变量提交契约、可用任务子代理目录。', '工具：正文写作、剧情提交、隔离工作区、询问用户、搜索、资料和变量操作；Skills 和任务子代理受开关控制。'],
  writer: ['系统提示：统一身份、Writer 写作职责、本轮会话设定。有附件时追加只读规则。', '用户消息：Prompt 工作台中排列的完整写作资料；Agent 可以另附本轮写作简报。', '工具：仅附件只读工具。Writer 不继承父模型的工具记录、Skills 目录或任务子代理。'],
  task: ['系统提示：统一身份、这个子代理的工作指令；允许使用 Skills 时加入本轮启用目录。', '用户消息：父模型显式传入的任务和结构化输入，以及当前附件清单。不继承父会话历史。', '工具：附件只读工具，以及这个子代理启用的 Skills、搜索。结果返回父模型审核，不直接提交剧情。'],
}
export function PromptSettings({ value, onChange }: { value: Preferences; onChange: (next: Partial<Preferences>) => void }) {
  useUiLanguage()
  const [selected, select] = useState('chat')
  const [previewValue, setPreviewValue] = useState(value)
  useEffect(() => { const timer = setTimeout(() => setPreviewValue(value), 250); return () => clearTimeout(timer) }, [value])
  const updating = previewValue !== value
  const query = useQuery({ queryKey: ['prompt-projection', previewValue.identity, previewValue.subagentsEnabled, previewValue.disabledSkills, previewValue.skills, previewValue.mainModel], queryFn: ({ signal }) => api<Projection>('/settings/prompt-preview', 'POST', { preferences: previewValue }, signal) })
  const target = query.data?.roles.find(role => role.id === selected) ?? query.data?.roles[0]
  return <><Field label={uiT("统一身份提示")} help={uiT("应用于 Chat、Agent、Writer 和任务子代理。留空保留各自默认职责；{{model}} 使用实际接收方的模型名称。")}><Textarea rows={5} maxLength={4000} value={value.identity} onChange={event => onChange({ identity: event.target.value })} /></Field>
    <div className="section-heading"><h3>{uiT("接收顺序")}</h3><span className="muted" role="status">{updating || query.isFetching ? uiT('正在更新预览…') : uiT(query.error ? (query.data ? '上次成功的预览' : '预览暂不可用') : '当前编辑内容的预览')}</span></div><p className="muted">{uiT("以下规则由运行时共用的组装器生成，反映当前编辑值。具体会话的模型覆盖、资料、附件和每轮工具定义请在该轮运行记录中查看。")}</p>
    <ErrorNotice error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />{query.isPending && <Loading />}
    {query.data && target && <><SettingsGroup><Field layout="row" label={uiT("查看接收方")} help={<>{uiT('模型：')}{target.model ? `${target.model.provider} / ${target.model.model}` : uiT('尚未选择')}</>}><Select value={target.id} onChange={event => select(event.target.value)}>{query.data.roles.map(role => <option key={role.id} value={role.id}>{role.role === 'task' ? uiT("任务子代理 · %{v0}%{v1}", { v0: role.label, v1: role.enabled ? '' : uiT("（未启用）") }) : uiT(role.label)}</option>)}</Select></Field></SettingsGroup>
      <ol className="prompt-delivery">{deliveries[target.role].map(item => <li key={item}>{uiT(item)}</li>)}</ol>
      {target.sections.map((section, index) => <details className="asset-detail-section" key={`${target.id}:${section.id}`}><summary>{index + 1}. {uiT(section.label)} · {section.text.length.toLocaleString(uiLocale())} {uiT(" 字符")}</summary><div className="asset-detail-body"><p className="muted">{uiT(section.source)}</p>{section.text ? <pre className="prompt-preview">{section.text}</pre> : <p className="muted">{uiT("未额外设置，不插入文本。")}</p>}</div></details>)}
      {!!query.data.diagnostics.length && <details><summary>{uiT("Skills 目录提示")}</summary><JsonView value={query.data.diagnostics} /></details>}
    </>}
  </>
}
