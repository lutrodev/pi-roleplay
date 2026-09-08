import { StatusNotice } from '../../components/status-notice.tsx'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { blankWriterHistory, blankWriterHistoryStep, compileWriterHistory, writerHistoryIssues, writerHistoryPreview, WRITER_HISTORY_LIMITS,
  type WriterHistoryConfig, type WriterHistoryRound, type WriterHistorySettings, type WriterHistoryStep } from '../../../../../packages/rp-core/src/agents/writer-history.ts'
import { exampleWriterHistory, writerHistoryEditorDraft } from '../../../../../packages/rp-core/src/agents/writer-history-example.ts'
import { api, queryClient, useAction } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { EditorForm } from '../../components/form-guard.tsx'
import { SettingsGroup } from '../../components/settings-layout.tsx'
import { SettingToggle } from '../../components/settings-controls.tsx'
import { Button, ErrorNotice, Field, IconButton, Input, Loading, Modal, Textarea } from '../../components/ui.tsx'
import './writer-history.css'

function issueText(issue: string) {
  const match = /^第 (\d+) 轮(?:，步骤 (\d+))?：(.*)$/.exec(issue)
  return match ? `${uiT('第 %{round} 轮', { round: match[1]! })}${match[2] ? ` · ${uiT('工具步骤 %{step}', { step: match[2] })}` : ''}: ${uiT(match[3]!)}` : uiT(issue)
}

export function WriterHistoryPanel({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  useUiLanguage()
  const query = useQuery({ queryKey: ['writer-history'], queryFn: () => api<WriterHistorySettings>('/settings/writer-history') })
  return <section className="settings-form writer-history stack"><ErrorNotice error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />
    {query.isPending ? <Loading /> : query.data && <HistoryEditor initial={query.data} onDirtyChange={onDirtyChange} />}</section>
}

function HistoryEditor({ initial, onDirtyChange }: { initial: WriterHistorySettings; onDirtyChange: (dirty: boolean) => void }) {
  const [baseline, setBaseline] = useState(initial), [value, setValue] = useState(() => writerHistoryEditorDraft(initial))
  const [saved, setSaved] = useState(false), [reset, setReset] = useState(false), [loadExample, setLoadExample] = useState(false), action = useAction()
  const dirty = JSON.stringify(value) !== JSON.stringify(baseline.config)
  const issues = useMemo(() => writerHistoryIssues(value), [value])
  const preview = useMemo(() => issues.length ? '' : writerHistoryPreview(compileWriterHistory(value)), [value, issues])
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length
  const blocked = bytes > WRITER_HISTORY_LIMITS.bytes || value.enabled && issues.length > 0
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  const blocker = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: dirty, withResolver: true })
  const patch = (next: Partial<WriterHistoryConfig>) => { setValue(current => ({ ...current, ...next })); setSaved(false) }
  const round = (index: number, next: Partial<WriterHistoryRound>) => patch({ rounds: value.rounds.map((item, i) => i === index ? { ...item, ...next } : item) })
  const step = (r: number, index: number, next: Partial<WriterHistoryStep>) => round(r, { steps: value.rounds[r]!.steps.map((item, i) => i === index ? { ...item, ...next } : item) })
  const move = (r: number, index: number, delta: number) => {
    const steps = [...value.rounds[r]!.steps], target = index + delta
    if (target < 0 || target >= steps.length) return
    ;[steps[index], steps[target]] = [steps[target]!, steps[index]!]
    round(r, { steps })
  }
  const accept = (result: WriterHistorySettings) => { setBaseline(result); setValue(structuredClone(result.config)); queryClient.setQueryData(['writer-history'], result) }
  return <><EditorForm className="stack" dirty={dirty} busy={action.busy} onSubmit={event => { event.preventDefault(); if (blocked) return; void action.run(async () => {
    accept(await api<WriterHistorySettings>('/settings/writer-history', 'PUT', { expectedRevision: baseline.revision, config: value })); setSaved(true)
  }) }}>
    <SettingsGroup layout="form" title={uiT('注入设置')}>
      <SettingToggle label={uiT('启用 Writer 预置历史')} checked={value.enabled} onChange={event => patch({ enabled: event.target.checked })}
        help={uiT('仅作用于新开始运行中的 Writer；当前运行、主模型和任务子代理不受影响。关闭时可以保存未完成草稿。')} />
      <p className="muted">{uiT('消息顺序：系统提示词 → 两轮预置历史 → 本次写作上下文。历史工具不会执行，也不会增加 Writer 的真实工具权限。')}</p>
      <p className="muted">{uiT('内置案例演示两轮写作交流，题材和生成内容留空供手动填写。所有消息与工具步骤都可以自由编辑。')}</p>
      <div className="section-heading writer-history-template-actions"><span className="muted">{uiT('已保存版本：%{revision}', { revision: baseline.revision })}</span><div className="writer-history-template-actions"><Button onClick={() => setLoadExample(true)}>{uiT('载入内置案例')}</Button><Button onClick={() => setReset(true)}>{uiT('恢复空模板')}</Button></div></div>
    </SettingsGroup>
    {value.rounds.map((item, r) => <SettingsGroup key={r} layout="form" title={uiT('第 %{round} 轮', { round: r + 1 })}>
      <Field label={uiT('用户消息')}><Textarea rows={4} value={item.user} onChange={event => round(r, { user: event.target.value })} /></Field>
      <div className="writer-history-steps">
        {item.steps.map((tool, s) => <fieldset key={s} className="writer-history-step"><legend>{uiT('工具步骤 %{step}', { step: s + 1 })}</legend>
          <div className="writer-history-step-actions">
            <IconButton label={uiT('上移步骤 %{step}', { step: s + 1 })} disabled={s === 0} onClick={() => move(r, s, -1)}><ArrowUp size={16} /></IconButton>
            <IconButton label={uiT('下移步骤 %{step}', { step: s + 1 })} disabled={s === item.steps.length - 1} onClick={() => move(r, s, 1)}><ArrowDown size={16} /></IconButton>
            <IconButton label={uiT('删除步骤 %{step}', { step: s + 1 })} onClick={() => round(r, { steps: item.steps.filter((_, i) => i !== s) })}><Trash2 size={16} /></IconButton>
          </div>
          <Field label={uiT('工具名')} help={uiT('1–64 位英文字母、数字、下划线或连字符。调用 ID 自动生成并配对。')}><Input value={tool.name} maxLength={64} spellCheck={false} onChange={event => step(r, s, { name: event.target.value })} /></Field>
          <div className="form-grid"><Field label={uiT('参数 JSON')}><Textarea className="writer-history-json" rows={5} value={tool.argumentsJson} spellCheck={false} onChange={event => step(r, s, { argumentsJson: event.target.value })} /></Field>
            <Field label={uiT('结果 JSON')}><Textarea className="writer-history-json" rows={5} value={tool.resultJson} spellCheck={false} onChange={event => step(r, s, { resultJson: event.target.value })} /></Field></div>
          <SettingToggle label={uiT('失败结果（isError）')} help={uiT('关闭表示成功；开启表示工具返回错误。')} checked={tool.isError} onChange={event => step(r, s, { isError: event.target.checked })} />
        </fieldset>)}
        <Button disabled={item.steps.length >= WRITER_HISTORY_LIMITS.steps} onClick={() => round(r, { steps: [...item.steps, blankWriterHistoryStep()] })}><Plus size={16} />{uiT('添加工具步骤')}</Button>
      </div>
      <Field label={uiT('助手最终回复')}><Textarea rows={4} value={item.assistant} onChange={event => round(r, { assistant: event.target.value })} /></Field>
    </SettingsGroup>)}
    <SettingsGroup layout="form" title={uiT('校验与原生消息预览')}>
      <p className="muted">{uiT('参数和结果必须是对象型 JSON；数字原文无损保留。最多 20,000 个编译字符、262,144 字节配置。')}</p>
      <p className="muted">{uiT('配置大小：%{bytes} 字节', { bytes })}{preview && ` · ${uiT('编译字符：%{count}', { count: preview.length })}`}</p>
      {bytes > WRITER_HISTORY_LIMITS.bytes && <StatusNotice compact tone="error" title={uiT('配置超过大小限制。')} />}
      {issues.length > 0 ? <details className="writer-history-validation" open={value.enabled || undefined}><summary>{uiT('还有 %{count} 项待完成', { count: issues.length })}</summary><ul>{issues.map((issue, index) => <li key={index}>{issueText(issue)}</li>)}</ul><p>{uiT('关闭注入后可以保存草稿；启用前必须完成全部校验。')}</p></details>
        : <details><summary>{uiT('查看原生消息（只读）')}</summary><pre className="writer-history-preview" tabIndex={0}>{preview}</pre></details>}
    </SettingsGroup>
    <ErrorNotice error={action.error} />
    <div className="form-actions sticky-actions"><span role="status">{dirty ? uiT('有未保存的更改') : saved ? uiT('Writer 预置历史已保存') : ''}</span>
      <Button disabled={action.busy} onClick={() => void action.run(async () => { accept(await api<WriterHistorySettings>('/settings/writer-history')); setSaved(false) })}>{uiT('放弃修改并重新读取')}</Button>
      <Button tone="primary" type="submit" disabled={action.busy || !dirty || blocked}>{action.busy ? uiT('正在保存…') : uiT('保存预置历史')}</Button></div>
  </EditorForm>
    <Modal size="compact" open={loadExample} onOpenChange={setLoadExample} title={uiT('载入内置案例')}><p>{uiT('将用两轮内置案例替换当前草稿，并关闭注入。点击保存后才会替换已保存的配置。')}</p><div className="form-actions"><Button onClick={() => setLoadExample(false)}>{uiT('取消')}</Button><Button tone="primary" onClick={() => { patch(exampleWriterHistory()); setLoadExample(false) }}>{uiT('使用内置案例')}</Button></div></Modal>
    <Modal size="compact" open={reset} onOpenChange={setReset} title={uiT('恢复空模板')}><p>{uiT('将清空当前编辑内容并关闭注入。点击保存后才会替换已保存的配置。')}</p><div className="form-actions"><Button onClick={() => setReset(false)}>{uiT('取消')}</Button><Button tone="danger" onClick={() => { patch(blankWriterHistory()); setReset(false) }}>{uiT('清空当前草稿')}</Button></div></Modal>
    <Modal size="compact" open={blocker.status === 'blocked'} onOpenChange={open => { if (!open) blocker.reset?.() }} title={uiT('预置历史还未保存')}><p>{uiT('离开页面会丢失刚才的修改。')}</p><div className="form-actions"><Button onClick={() => blocker.proceed?.()}>{uiT('放弃修改并离开')}</Button><Button tone="primary" onClick={() => blocker.reset?.()}>{uiT('继续编辑')}</Button></div></Modal>
  </>
}
