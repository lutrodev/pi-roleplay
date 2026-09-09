import { ContentImage } from '../components/content-image.tsx'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { BookOpen, ChevronDown, ChevronRight, Folder, PencilLine, Settings2, UserRound } from 'lucide-react'
import type { MessageInput, StoryProfile } from '../../../../packages/rp-core/src/types.ts'
import { api, refreshStory, useAction, useAsset, useModels, useSettings } from '../lib/api.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { useWorkspaces } from '../lib/workspaces.ts'
import { referenceText } from '../lib/reference-text.ts'
import { PageHeader } from '../components/shell-context.tsx'
import { SettingsGroup } from '../components/settings-layout.tsx'
import { Button, ErrorNotice, Field, IconButton, Input, Loading, Menu, MenuLabel, MenuRadioGroup, MenuRadioItem, Modal, Select } from '../components/ui.tsx'
import { Composer, type ComposerStory } from './story/composer.tsx'
import { RuntimeProfile } from './story/runtime-profile.tsx'
import { transferStoryDraft, useStoryDraft } from './story/draft.ts'
import { NewStory, type SetupStep } from './new-story.tsx'
import { cardOpenings, creationProfile, readNewConversationOptions, type NewConversationOptions } from './new-story-state.ts'

export function NewConversationPage() {
  const { workspace } = useSearch({ from: '/new' })
  return <NewConversation key={workspace ?? ''} workspaceId={workspace ?? ''} />
}
function NewConversation({ workspaceId }: { workspaceId: string }) {
  useUiLanguage()
  const settings = useSettings(), defaults = useQuery({ queryKey: ['defaults'], queryFn: () => api<{ defaults: { persona: string; preset: string; writingStyle: string } }>('/assets/defaults') })
  if (!settings.data || !defaults.data) return <div className="page-screen"><PageHeader title={uiT('新会话')} /><div className="page-content"><ErrorNotice source="read" error={settings.error ?? defaults.error} retry={() => { void settings.refetch(); void defaults.refetch() }} retrying={settings.isFetching || defaults.isFetching} />{!settings.error && !defaults.error && <Loading />}</div></div>
  const shared = defaults.data.defaults
  const profile: StoryProfile = { revision: 0, playerCharacterId: 'player', cast: [{ characterId: 'player', name: uiT('我'), controller: 'user' }], scene: { openingSource: 'skip' }, runtime: { executionMode: 'chat' }, resources: {
    persona: { id: shared.persona }, preset: { id: shared.preset }, lorebooks: [], writingStyles: [{ id: shared.writingStyle }],
  } }
  return <DraftConversation initial={{ title: '', workspaceId, profile, includeAssociatedLorebooks: true }} preferences={settings.data.preferences} />
}
function DraftConversation({ initial, preferences }: { initial: NewConversationOptions; preferences: NonNullable<ReturnType<typeof useSettings>['data']>['preferences'] }) {
  const draftKey = `new:${initial.workspaceId}`, optionsKey = `rp-new-options:${initial.workspaceId}`
  const state = useStoryDraft(draftKey), navigate = useNavigate(), workspaces = useWorkspaces(), models = useModels(), create = useAction()
  const [restored] = useState(() => {
    try { return { value: readNewConversationOptions(sessionStorage.getItem(optionsKey), initial), error: null } }
    catch (error) { return { value: initial, error: new Error(uiT('新会话的本地设置无法读取，已恢复默认设置。输入内容仍保留。')) } }
  })
  const [options, setOptions] = useState(restored.value), [setup, setSetup] = useState<SetupStep | null>(null), [advanced, setAdvanced] = useState(false), [busy, setBusy] = useState(false)
  const pending = useRef(state.draft.request), lock = useRef(false), mounted = useRef(true)
  const card = useAsset(options.profile.resources.card?.id)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { try { sessionStorage.setItem(optionsKey, JSON.stringify(options)) } catch { /* Keep the live draft. */ } }, [options, optionsKey])
  const workspace = workspaces.data?.workspaces.find(item => item.id === options.workspaceId)
  const story: ComposerStory = { id: draftKey, revision: 0, archived: false, profile: options.profile, messages: [], maintenance: {} }
  const change = (next: NewConversationOptions) => { create.clear(); setOptions(next) }
  const start = async (inputs?: MessageInput[]) => {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try {
      if (options.workspaceId && !workspace) throw new Error(uiT('所选文件工作区不可用，请重新选择。'))
      if (options.profile.resources.card && !card.data) throw card.error ?? new Error(uiT('正在读取角色与关联资料…'))
      if (options.profile.scene.openingSource === 'card' && !cardOpenings(card.data?.asset.data).some(item => item.index === (options.profile.scene.openingIndex ?? 0))) throw new Error(uiT('请选择一个可用的角色开场。'))
      if (options.profile.scene.openingSource === 'custom' && !options.profile.scene.openingText?.trim()) throw new Error(uiT('请写下开场正文，或选择直接对话。'))
      if (inputs) {
        const route = options.profile.runtime.provider && options.profile.runtime.model ? options.profile.runtime : models.data?.effectiveMain
        if (!models.data?.models.some(model => model.provider === route?.provider && model.model === route?.model && model.configured)) throw new Error(uiT('请先在设置中连接模型，或选择已配置的模型。'))
      }
      const text = referenceText(inputs?.[0]?.text ?? '').text.trim().replace(/\s+/gu, ' ')
      const profile = creationProfile(options, card.data?.associatedLorebooks ?? [])
      const body = { title: options.title.trim() || [...text].slice(0, 36).join('') || [...(card.data?.asset.name ?? '')].slice(0, 120).join('') || [...(state.draft.files[0]?.name ?? '')].slice(0, 80).join('') || uiT('新会话'), profile, useDefaults: false, ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}), ...(inputs ? { inputs } : {}) }
      const payload = JSON.stringify(body), request = pending.current?.payload === payload ? pending.current : { payload, id: crypto.randomUUID() }
      pending.current = request; state.setDraft(value => ({ ...value, request }))
      // Both commands are atomic and reuse this id after an uncertain network response.
      const result = inputs ? await api<{ storyId: string }>('/stories/start', 'POST', { ...body, requestId: request.id })
        : await api<{ story: { id: string } }>('/stories', 'POST', { ...body, requestId: request.id })
      const storyId = 'storyId' in result ? result.storyId : result.story.id
      await refreshStory(storyId)
      if (!inputs) transferStoryDraft(storyId, { text: state.draft.text, files: state.draft.files })
      try {
        const current = JSON.parse(sessionStorage.getItem(`rp-draft:${draftKey}`) ?? 'null')
        if (current?.request?.id === request.id && current.text === state.draft.text && JSON.stringify(current.files) === JSON.stringify(state.draft.files)) sessionStorage.removeItem(`rp-draft:${draftKey}`)
        if (sessionStorage.getItem(optionsKey) === JSON.stringify(options)) sessionStorage.removeItem(optionsKey)
      } catch { /* The committed conversation remains available if local storage is full. */ }
      if (mounted.current) await navigate({ to: '/stories/$storyId', params: { storyId } })
    } finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  const openSetup = (step: SetupStep) => { create.clear(); setSetup(step) }
  const hasOpening = options.profile.scene.openingSource !== 'skip'
  const openingReady = options.profile.scene.openingSource === 'custom' ? !!options.profile.scene.openingText?.trim() : cardOpenings(card.data?.asset.data).some(item => item.index === (options.profile.scene.openingIndex ?? 0))
  const workspaceName = workspace?.name ?? uiT(options.workspaceId ? '工作区不可用' : '独立会话')
  const openOpening = () => {
    if (!hasOpening) change({ ...options, profile: { ...options.profile, scene: { ...options.profile.scene, openingSource: 'custom' } } })
    openSetup('opening')
  }
  const closeSetup = () => {
    // Dismissing an untouched opening editor must leave direct sending available.
    if (options.profile.scene.openingSource === 'custom' && !options.profile.scene.openingText?.trim()) change({ ...options, profile: { ...options.profile, scene: { ...options.profile.scene, openingSource: 'skip' } } })
    setSetup(null)
  }
  return <div className="page-screen new-conversation-page">
    <PageHeader title={uiT('新会话')} actions={<>
      <Menu label={uiT('文件工作区')} trigger={<Button tone="quiet" className="new-conversation-workspace" disabled={busy} aria-label={uiT('文件工作区：%{name}', { name: workspaceName })} title={workspaceName}><Folder size={15} /><span>{workspaceName}</span><ChevronDown size={13} /></Button>}>
        <MenuLabel>{uiT('新会话的文件位置')}</MenuLabel>
        <MenuRadioGroup value={options.workspaceId} onValueChange={workspaceId => change({ ...options, workspaceId })}>
          <MenuRadioItem value=""><span>{uiT('独立会话')}<small className="menu-description">{uiT('使用独立的文件目录')}</small></span></MenuRadioItem>
          {options.workspaceId && !workspace && <MenuRadioItem value={options.workspaceId} disabled>{uiT('工作区不可用')}</MenuRadioItem>}
          {workspaces.data?.workspaces.map(item => <MenuRadioItem key={item.id} value={item.id}><span>{item.name}<small className="menu-description">{uiT('共享这个工作区的文件')}</small></span></MenuRadioItem>)}
        </MenuRadioGroup>
      </Menu>
      <IconButton label={uiT('会话设置')} disabled={busy} onClick={() => setAdvanced(true)}><Settings2 size={17} /></IconButton>
    </>} />
    <div className="new-conversation-content"><div className="new-conversation-heading">{card.data?.asset.avatarFileId && <ContentImage className="new-conversation-avatar" src={`/api/files/${card.data.asset.avatarFileId}/content`} alt="" />}<h2>{card.data ? uiT('和 %{name} 开始对话', { name: card.data.asset.name }) : uiT('开始一段新对话')}</h2><p>{hasOpening ? uiT(openingReady ? '直接写下第一句回应，或先预览下方的故事开场。' : '继续完成故事开场，也可以改为直接对话。') : uiT('写下想聊的内容，发送第一条消息就会创建会话。')}</p></div>
      <Composer story={story} active={undefined} preferences={preferences} state={state} openSettings={() => setAdvanced(true)} onSent={() => {}} newSession={{ submit: start, changeProfile: profile => change({ ...options, profile }), access: workspace?.access ?? 'read-write' }} />
      <section className="new-conversation-starters" aria-label={uiT('故事起步方式')}>
        <p className="new-conversation-starters-label">{uiT(hasOpening ? openingReady ? '故事准备好了' : '开场还没完成' : '也可以从一个故事开始')}</p>
        <div className="new-conversation-starter-actions">
          {<Button tone="quiet" className="new-conversation-starter" disabled={busy} onClick={() => openSetup('assets')}>
            <UserRound size={20} strokeWidth={1.5} />
            <span><strong>{card.data?.asset.name ?? uiT('选角色，开始故事')}</strong><small>{card.data ? uiT('更换角色，或调整资料') : uiT('挑选角色与资料，再确认开场')}</small></span>
            <ChevronRight size={15} />
          </Button>}
          <Button tone="quiet" className="new-conversation-starter" disabled={busy} onClick={openOpening}>
            {hasOpening ? <BookOpen size={20} strokeWidth={1.5} /> : <PencilLine size={20} strokeWidth={1.5} />}
            <span><strong>{uiT(hasOpening ? openingReady ? '预览开场，进入故事' : '继续设置开场' : '自己写开场')}</strong><small>{uiT(hasOpening ? openingReady ? '看看第一幕，准备好就开始' : '补全开场，或改为直接对话' : '写下场景，让故事从这里继续')}</small></span>
            <ChevronRight size={15} />
          </Button>
        </div>
      </section>
      <ErrorNotice source="read" error={restored.error ?? card.error ?? workspaces.error ?? models.error} />
    </div>
    <NewStory open={setup !== null} initialStep={setup ?? 'assets'} value={options} onChange={change} onOpenChange={open => { if (!open) closeSetup() }} onStart={() => void create.run(() => start())} busy={busy} error={create.error} />
    <Modal size="form" open={advanced} onOpenChange={setAdvanced} title={uiT('会话设置')} description={uiT('本次会话使用的名称、工作区与模型。')}><div className="stack"><SettingsGroup><Field layout="row" label={uiT('名称（可选）')}><Input maxLength={120} value={options.title} placeholder={uiT('根据第一条消息命名')} onChange={event => change({ ...options, title: event.target.value })} /></Field>
      <Field layout="row" label={uiT('文件工作区')} help={uiT('独立会话使用自己的文件目录；同一工作区内的会话共享文件。')}><Select aria-label={uiT('文件工作区')} value={options.workspaceId} disabled={busy} onChange={event => change({ ...options, workspaceId: event.target.value })}><option value="">{uiT('独立会话')}</option>{options.workspaceId && !workspace && <option value={options.workspaceId}>{uiT('工作区不可用')}</option>}{workspaces.data?.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field></SettingsGroup>
      <RuntimeProfile value={options.profile.runtime} onChange={runtime => change({ ...options, profile: { ...options.profile, runtime } })} /><div className="form-actions sticky-actions"><Button tone="primary" onClick={() => setAdvanced(false)}>{uiT('完成')}</Button></div></div></Modal>
  </div>
}
