import { EditorFooter } from '../components/editor-footer.tsx'
import { EditorForm } from '../components/form-guard.tsx'
import { uiT, useUiLanguage } from "../lib/i18n.ts"
import { useLayoutEffect, useRef, useState } from 'react'
import { Link, useBlocker, useNavigate, useSearch } from '@tanstack/react-router'
import { Activity, ArrowLeft, BookOpen, Bot, Boxes, ChevronRight, LogOut, MessageSquareText, Paintbrush, ScrollText, Sparkles, Wrench } from 'lucide-react'
import type { Preferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import { api, queryClient, useAction, useSettings, type Settings } from '../lib/api.ts'
import { Button, ErrorNotice, Loading, Modal } from '../components/ui.tsx'
import { PageHeader } from '../components/shell-context.tsx'
import { useMediaQuery } from '../lib/use-media-query.ts'
import { QuickReplySettings } from './settings/quick-replies.tsx'
import { ReplyOptionControls } from '../components/reply-option-controls.tsx'
import { Subagents } from './settings/subagents.tsx'
import { PromptSettings } from './settings/prompts.tsx'
import { ProviderManager } from './settings/providers.tsx'
import { ToolSettingsPanel } from './settings/tools.tsx'
import { WriterHistoryPanel } from './settings/writer-history.tsx'
import { ReadingSettings } from './settings/reading.tsx'
import { SkillSettings } from './settings/skills.tsx'
import { SystemStatus } from './settings/status.tsx'
import { mergeSection, preferenceGroups, sectionChanged, type PreferenceGroup } from './settings/preference-drafts.ts'
import type { SettingsSection } from './settings/location.ts'

export function SettingsPage() {
  useUiLanguage()
  const query = useSettings(), logout = useAction()
  const [dirty, setDirty] = useState(false), [confirmLogout, setConfirmLogout] = useState(false)
  const signOut = () => void logout.run(async () => {
    await api('/auth/logout', 'POST')
    await queryClient.cancelQueries()
    // Unmount the settings drafts before returning to login, without a second browser leave prompt.
    queryClient.setQueryData(['auth'], { authenticated: false, configured: true })
    queryClient.removeQueries({ predicate: query => query.queryKey[0] !== 'auth' })
  })
  return <div className="page-screen"><PageHeader title={uiT("设置")} actions={<Button tone="quiet" disabled={logout.busy} onClick={() => dirty ? setConfirmLogout(true) : signOut()}><LogOut size={16} />{logout.busy ? uiT('正在退出…') : uiT('退出登录')}</Button>} /><div className="page-content settings-page"><div className="page-inner"><ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} /><ErrorNotice error={confirmLogout ? null : logout.error} />{query.isPending ? <Loading /> : query.data && <SettingsForm initial={query.data} onDirtyChange={setDirty} />}</div></div>
    <Modal size="compact" open={confirmLogout} onOpenChange={setConfirmLogout} title={uiT('设置还未保存')}><EditorForm className="stack" busy={logout.busy} onSubmit={signOut}><p>{uiT('离开页面会丢失刚才的修改。')}</p><ErrorNotice error={logout.error} /><div className="form-actions"><Button type="submit" tone="danger" disabled={logout.busy}>{uiT('放弃修改并退出登录')}</Button><Button tone="primary" onClick={() => setConfirmLogout(false)} disabled={logout.busy}>{uiT('继续编辑')}</Button></div></EditorForm></Modal>
  </div>
}
function SettingsForm({ initial, onDirtyChange }: { initial: Settings; onDirtyChange: (dirty: boolean) => void }) {
  useUiLanguage()
  const { section } = useSearch({ from: '/settings' }), navigate = useNavigate({ from: '/settings' })
  const tab = section ?? 'models', setTab = (section: SettingsSection) => { if (!action.busy) void navigate({ search: { section } }) }
  const [value, setValue] = useState<Preferences>(() => structuredClone(initial.preferences)), [revision, setRevision] = useState(initial.revision), [saved, setSaved] = useState<SettingsSection | null>(null), action = useAction()
  const [toolsDirty, setToolsDirty] = useState(false)
  const [writerHistoryDirty, setWriterHistoryDirty] = useState(false)
  const patch = (next: Partial<Preferences>) => { setValue(current => ({ ...current, ...next })); setSaved(null) }
  const mobile = useMediaQuery('(max-width: 800px)'), [baseline, setBaseline] = useState(() => JSON.stringify(initial.preferences))
  const showIndex = mobile && !section
  const dirty = JSON.stringify(value) !== baseline
  useLayoutEffect(() => { onDirtyChange(dirty || toolsDirty || writerHistoryDirty) }, [dirty, toolsDirty, writerHistoryDirty, onDirtyChange])
  const stored = JSON.parse(baseline) as Preferences
  const pending = (Object.keys(preferenceGroups) as PreferenceGroup[]).filter(group => sectionChanged(stored, value, group))
  const visibleDirty = pending.includes(tab as PreferenceGroup)
  const otherPending = pending.find(group => group !== tab) ?? (toolsDirty && tab !== 'tools' ? 'tools' : undefined) ?? (writerHistoryDirty && tab !== 'writer-history' ? 'writer-history' : undefined)
  const contentRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { contentRef.current?.scrollTo({ top: 0, left: 0, behavior: 'instant' }) }, [tab])
  useLayoutEffect(() => { if (mobile && section) contentRef.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true }) }, [section, mobile])
  const blocker = useBlocker({ shouldBlockFn: ({ next }) => dirty && next.pathname !== '/settings', enableBeforeUnload: dirty, withResolver: true })
  const saveImmediate = async (changes: Partial<Pick<Preferences, 'mainModel' | 'subagentsEnabled'>>) => {
    const result = await api<Settings>('/settings', 'PUT', { expectedRevision: revision, preferences: { ...stored, ...changes } })
    setRevision(result.revision); setValue(current => ({ ...current, ...changes })); setBaseline(JSON.stringify(result.preferences))
    queryClient.setQueryData(['settings'], result)
    await Promise.all(['models', 'prompt-projection'].map(key => queryClient.invalidateQueries({ queryKey: [key] })))
  }
  const categories = [
    { value: 'models', label: uiT('模型'), icon: <Boxes size={16} />, description: uiT('连接模型服务，管理可使用的模型。') },
    { value: 'reading', label: uiT('通用与外观'), icon: <Paintbrush size={16} />, description: uiT('界面语言与正文阅读偏好。') },
    { value: 'quick-replies', label: uiT('快捷回复'), icon: <MessageSquareText size={16} />, description: uiT('自定义常用文字和符号；点击快捷按钮后插入输入框。') },
    { value: 'reply-options', label: uiT('回复选项'), icon: <Sparkles size={16} />, description: uiT('根据故事正文生成可选回复，设置建议数量、目标字数和方向。') },
    { value: 'prompts', label: uiT('系统提示词'), icon: <ScrollText size={16} />, description: uiT('统一身份提示与各模型接收的系统规则。') },
    { value: 'skills', label: 'Skills', icon: <BookOpen size={16} />, description: uiT('管理可由模型按需读取的指导。') },
    { value: 'subagents', label: uiT('子代理'), icon: <Bot size={16} />, description: uiT('Writer 负责生成正文。任务子代理按你的调用说明参与规划、核对或润色，主模型决定何时使用。') },
    { value: 'writer-history', label: uiT('Writer 预置历史'), icon: <ScrollText size={16} />, description: uiT('设置 Writer 开始写作前读取的两轮示例对话。保存后用于新的生成。') },
    { value: 'tools', label: uiT('工具'), icon: <Wrench size={16} />, description: uiT('保存后从下一次开始的生成生效；当前运行保留原来的参数。') },
    { value: 'status', label: uiT('服务状态'), icon: <Activity size={16} />, description: uiT('查看服务连接、备份与运行状态。') },
  ] as const
  const current = categories.find(item => item.value === tab)!
  return <><div className={'settings-layout' + (tab === 'models' || tab === 'subagents' ? ' model-settings-layout' : '')}>
    <nav className="settings-navigation" aria-label={uiT('设置分类')} hidden={mobile && !showIndex}>
      {categories.map(item => <Link key={item.value} to="/settings" search={{ section: item.value }} aria-current={tab === item.value && !showIndex ? 'page' : undefined} aria-disabled={action.busy || undefined} onClick={event => { if (action.busy) event.preventDefault() }}>
        {item.icon}<span>{item.label}{mobile && <small>{item.description}</small>}</span>{(pending.includes(item.value as PreferenceGroup) || item.value === 'tools' && toolsDirty || item.value === 'writer-history' && writerHistoryDirty) && <span className="settings-draft-dot" aria-label={uiT('有未保存的更改')} />}{mobile && <ChevronRight size={16} />}
      </Link>)}
    </nav>
    <section className="settings-panel" hidden={showIndex}>
    {mobile && <div className="settings-back"><Button tone="quiet" disabled={action.busy} onClick={() => void navigate({ search: {} })}><ArrowLeft size={16} />{uiT('所有设置')}</Button></div>}
    <div className="settings-content" ref={contentRef} aria-label={current.label}>
    <header className="settings-panel-heading"><h2 tabIndex={-1}>{current.label}</h2><p>{current.description}</p></header>
    {otherPending && <div className="notice section-heading settings-draft-notice" role="status"><span>{uiT('“%{name}”还有未保存的更改。', { name: categories.find(item => item.value === otherPending)!.label })}</span><Button onClick={() => setTab(otherPending)}>{uiT('返回编辑')}</Button></div>}
    {tab === 'status' ? <SystemStatus onNavigate={setTab} /> : tab === 'tools' || tab === 'models' || tab === 'subagents' || tab === 'writer-history' ? null : <EditorForm busy={action.busy} className="settings-form stack" onSubmit={event => { event.preventDefault(); const group = tab as PreferenceGroup; void action.run(async () => { const result = await api<Settings>('/settings', 'PUT', { expectedRevision: revision, preferences: mergeSection(stored, value, group) }); setRevision(result.revision); setValue(current => mergeSection(current, result.preferences, group)); setBaseline(JSON.stringify(result.preferences)); await Promise.all(['settings', 'skills', 'models', 'prompt-projection'].map(key => queryClient.invalidateQueries({ queryKey: [key] }))); setSaved(tab) }) }}>
      {tab === 'reading' && <ReadingSettings value={value} onChange={patch} />}
      {tab === 'quick-replies' && <QuickReplySettings value={value} onChange={patch} />}
      {tab === 'reply-options' && <ReplyOptionControls value={value} onChange={patch} />}
      {tab === 'prompts' && <PromptSettings value={value} onChange={patch} />}
      {tab === 'skills' && <SkillSettings value={value} onChange={patch} />}
      <EditorFooter error={action.error}><span className="settings-save-status" role="status">{visibleDirty ? uiT("有未保存的更改") : saved === tab ? uiT("设置已保存") : ''}</span><Button disabled={action.busy || !visibleDirty} onClick={() => { setValue(current => mergeSection(current, stored, tab as PreferenceGroup)); setSaved(null) }}>{uiT('放弃修改')}</Button><Button tone="primary" type="submit" disabled={action.busy || !visibleDirty}>{action.busy ? uiT("正在保存…") : uiT("保存设置")}</Button></EditorFooter>
    </EditorForm>}
    {tab === 'subagents' && <Subagents enabled={stored.subagentsEnabled} onEnabledChange={subagentsEnabled => saveImmediate({ subagentsEnabled })} />}
    {tab === 'models' && <ProviderManager value={stored.mainModel} onDefault={mainModel => saveImmediate({ mainModel })} />}
    <div hidden={tab !== 'tools'}><ToolSettingsPanel onDirtyChange={setToolsDirty} /></div>
    <div hidden={tab !== 'writer-history'}><WriterHistoryPanel onDirtyChange={setWriterHistoryDirty} /></div>
  </div></section></div><Modal size="compact" open={blocker.status === 'blocked'} onOpenChange={open => { if (!open) blocker.reset?.() }} title={uiT("设置还未保存")}><p>{uiT("离开页面会丢失刚才的修改。")}</p><div className="form-actions"><Button onClick={() => blocker.proceed?.()}>{uiT("放弃修改并离开")}</Button><Button tone="primary" onClick={() => blocker.reset?.()}>{uiT("继续编辑")}</Button></div></Modal></>
}
