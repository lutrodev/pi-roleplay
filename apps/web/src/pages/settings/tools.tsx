import { SettingsGroup } from '../../components/settings-layout.tsx'
import { EditorForm } from '../../components/form-guard.tsx'
import { useEffect, useState } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { DEFAULT_TOOL_SETTINGS, type ToolSettings } from '../../../../../packages/rp-core/src/settings/tools.ts'
import type { ToolSettingsSnapshot } from '../../../../server/src/services/tool-settings-service.ts'
import { api, queryClient, useAction } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { SettingToggle } from '../../components/settings-controls.tsx'
import { Button, ErrorNotice, Field, Input, Loading, Modal } from '../../components/ui.tsx'

export function ToolSettingsPanel({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  useUiLanguage()
  const query = useQuery({ queryKey: ['tool-settings'], queryFn: () => api<ToolSettingsSnapshot>('/settings/tools') })
  return <section className="settings-form tool-settings stack"><ErrorNotice error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />{query.isPending ? <Loading /> : query.data && <ToolSettingsEditor initial={query.data} onDirtyChange={onDirtyChange} />}</section>
}

function ToolSettingsEditor({ initial, onDirtyChange }: { initial: ToolSettingsSnapshot; onDirtyChange?: (dirty: boolean) => void }) {
  useUiLanguage()
  const [baseline, setBaseline] = useState(initial), [value, setValue] = useState(() => structuredClone(initial.settings))
  const [key, setKey] = useState(''), [clearKey, setClearKey] = useState(false), [saved, setSaved] = useState(false)
  const action = useAction()
  const dirty = key.length > 0 || clearKey || JSON.stringify(value) !== JSON.stringify(baseline.settings)
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  const blocker = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: dirty, withResolver: true })
  const patch = (next: Partial<ToolSettings>) => { setValue(current => ({ ...current, ...next })); setSaved(false) }
  const accept = (result: ToolSettingsSnapshot) => { setBaseline(result); setValue(structuredClone(result.settings)); setKey(''); setClearKey(false); queryClient.setQueryData(['tool-settings'], result) }
  return <><EditorForm className="stack" dirty={dirty} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => {
    const result = await api<ToolSettingsSnapshot>('/settings/tools', 'PUT', { expectedRevision: baseline.revision, settings: value, ...(key.trim() ? { apiKey: key.trim() } : {}), ...(clearKey ? { clearKey: true } : {}) })
    accept(result); setSaved(true); await queryClient.invalidateQueries({ queryKey: ['system-status'] })
  }) }}>
    <SettingsGroup title={uiT('终端')} actions={<Button onClick={() => patch({ commandTimeoutMs: DEFAULT_TOOL_SETTINGS.commandTimeoutMs, maxOutputBytes: DEFAULT_TOOL_SETTINGS.maxOutputBytes, maxParallelToolCalls: DEFAULT_TOOL_SETTINGS.maxParallelToolCalls })}>{uiT('恢复运行参数默认值')}</Button>}>
      <Field layout="row" label={uiT('命令超时（毫秒）')} help={uiT('单条命令超过这个时限会终止，并重置 Bash 环境。')}><Input required type="number" min={1} max={300000} step={1} value={value.commandTimeoutMs} onChange={event => patch({ commandTimeoutMs: Number(event.target.value) })} /></Field>
      <Field layout="row" label={uiT('输出上限（字节）')} help={uiT('限制页面与模型中直接显示的 UTF-8 输出；超出后完整输出保存在工作区文件中。')}><Input required type="number" min={1} max={1048576} step={1} value={value.maxOutputBytes} onChange={event => patch({ maxOutputBytes: Number(event.target.value) })} /></Field>
      <Field layout="row" label={uiT('并行工具调用数')} help={uiT('同一步中可同时执行的独立读取、搜索和子代理调用，最多 8 个。写入、Bash 与剧情提交按顺序执行。')}><Input required type="number" min={1} max={8} step={1} value={value.maxParallelToolCalls} onChange={event => patch({ maxParallelToolCalls: Number(event.target.value) })} /></Field>
    </SettingsGroup>
    <SettingsGroup layout="form" title={uiT('网页搜索')} description={uiT('搜索需要支持原生 Web Search 的 Anthropic 兼容端点与专用密钥。主对话模型的 ClinePass 配置不会自动用作搜索服务。')}>
    <Field label={uiT('搜索 API 基础地址')} help={uiT('填写 API 前缀，不包含 /messages、密钥或查询参数。停用搜索时将地址和模型同时清空。')}><Input type="url" maxLength={4096} value={value.search.baseUrl} onChange={event => patch({ search: { ...value.search, baseUrl: event.target.value } })} /></Field>
    <div className="form-grid"><Field label={uiT('搜索模型 ID')}><Input maxLength={200} value={value.search.model} onChange={event => patch({ search: { ...value.search, model: event.target.value } })} /></Field><Field label={uiT('单次请求最多搜索次数')}><Input required type="number" min={1} max={5} step={1} value={value.search.maxUses} onChange={event => patch({ search: { ...value.search, maxUses: Number(event.target.value) } })} /></Field></div>
    <p role="status" className="muted">{baseline.searchKey.configured ? baseline.searchKey.source === 'saved' ? uiT('搜索密钥已加密保存') : uiT('使用部署环境中的搜索密钥') : uiT('尚未配置搜索密钥')}</p>
    <Field label={uiT('替换搜索 API 密钥')} help={uiT('留空保留当前密钥。保存后不回显，数据库中只保存密文。')}><Input type="password" autoComplete="new-password" maxLength={8192} value={key} disabled={clearKey} onChange={event => { setKey(event.target.value); setSaved(false) }} /></Field>
    <Button disabled={!value.search.baseUrl && !value.search.model} onClick={() => patch({ search: { ...value.search, baseUrl: '', model: '' } })}>{uiT('清空搜索连接')}</Button>
    <SettingToggle label={uiT('移除当前搜索密钥')} checked={clearKey} onChange={event => { setClearKey(event.target.checked); setSaved(false); if (event.target.checked) setKey('') }} />
    </SettingsGroup>
    <ErrorNotice error={action.error} /><div className="form-actions sticky-actions"><span role="status">{dirty ? uiT('有未保存的更改') : saved ? uiT('设置已保存') : ''}</span><Button disabled={action.busy || !dirty} onClick={() => void action.run(async () => { accept(await api<ToolSettingsSnapshot>('/settings/tools')); setSaved(false) })}>{uiT('放弃修改')}</Button><Button tone="primary" type="submit" disabled={action.busy || !dirty}>{action.busy ? uiT('正在保存…') : uiT('保存工具设置')}</Button></div>
  </EditorForm>
    <Modal size="compact" open={blocker.status === 'blocked'} onOpenChange={open => { if (!open) blocker.reset?.() }} title={uiT('工具设置还未保存')}><p>{uiT('离开页面会丢失刚才的修改。')}</p><div className="form-actions"><Button onClick={() => blocker.proceed?.()}>{uiT('放弃修改并离开')}</Button><Button tone="primary" onClick={() => blocker.reset?.()}>{uiT('继续编辑')}</Button></div></Modal>
  </>
}
