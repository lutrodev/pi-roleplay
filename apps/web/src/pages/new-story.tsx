import { ContentImage } from '../components/content-image.tsx'
import { useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check as CheckIcon, UserRound } from 'lucide-react'
import type { AssetKind, StoryProfile } from '../../../../packages/rp-core/src/types.ts'
import { api, useAsset } from '../lib/api.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { useMediaQuery } from '../lib/use-media-query.ts'
import { AssetSelection, assetLabels } from '../components/selectors.tsx'
import { EditorForm } from '../components/form-guard.tsx'
import { Button, Check, ErrorNotice, Loading, Modal, TabGroup } from '../components/ui.tsx'
import { NewStoryOpening } from './new-story-opening.tsx'
import { cardOpenings, selectCharacter, selectedLorebookIds, selectLorebooks, type NewConversationOptions } from './new-story-state.ts'

export type { NewConversationOptions } from './new-story-state.ts'
export type SetupStep = 'assets' | 'opening'
const resourceKinds = ['character', 'lorebook', 'persona', 'preset', 'writingStyle'] as const
const resourceKey = { character: 'card', lorebook: 'lorebooks', persona: 'persona', preset: 'preset', writingStyle: 'writingStyles' } as const

interface SetupProps {
  value: NewConversationOptions
  onChange: (value: NewConversationOptions) => void
  onStart: () => void
  busy: boolean
  error: Error | null
  initialStep?: SetupStep
}
export function NewStory({ open, onOpenChange, ...props }: SetupProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Modal open={open} onOpenChange={onOpenChange} title={uiT('角色与开场')} description={uiT('资料不用一次备齐，开始后也能随时调整。')} size="workspace" className="new-story-setup" onCloseAutoFocus={event => {
    const input = document.querySelector<HTMLTextAreaElement>('.new-conversation-page .composer textarea')
    if (input) { event.preventDefault(); input.focus({ preventScroll: true }) }
  }}>{open && <Setup {...props} done={() => onOpenChange(false)} />}</Modal>
}
function Setup({ value, onChange, onStart, busy, error, initialStep = 'assets', done }: SetupProps & { done: () => void }) {
  useUiLanguage()
  const defaults = useQuery({ queryKey: ['defaults'], queryFn: () => api<{ defaults: { persona: string; preset: string; writingStyle: string } }>('/assets/defaults') })
  const kinds = resourceKinds
  const [step, setStep] = useState<SetupStep>(initialStep), [tab, setTab] = useState<AssetKind>(kinds[0] ?? 'character')
  const scroll = useRef<HTMLDivElement>(null), vertical = useMediaQuery('(min-width: 701px)')
  const { profile } = value, { resources, scene } = profile
  const card = useAsset(resources.card?.id), persona = useAsset(resources.persona?.id)
  const associated = card.data?.associatedLorebooks ?? [], bookIds = selectedLorebookIds(value, associated)
  const associatedCount = associated.filter(book => bookIds.includes(book.id)).length
  const openings = cardOpenings(card.data?.asset.data), selectedOpening = openings.find(item => item.index === (scene.openingIndex ?? 0))
  const patch = (next: Partial<StoryProfile>) => onChange({ ...value, profile: { ...profile, ...next } })
  const select = (kind: AssetKind, ids: string[]) => {
    if (kind === 'character') return onChange(selectCharacter(value, ids[0]))
    if (kind === 'lorebook') return onChange(selectLorebooks(value, ids, associated))
    const multiple = kind === 'writingStyle'
    onChange({ ...value, profile: { ...profile,
      resources: { ...resources, [resourceKey[kind]]: multiple ? ids.map(id => ({ id })) : ids[0] ? { id: ids[0] } : undefined },
    } })
  }
  useLayoutEffect(() => {
    scroll.current?.scrollTo({ top: 0, behavior: 'instant' })
    if (step === 'opening') (scroll.current?.querySelector<HTMLElement>('textarea[data-autofocus]') ?? scroll.current?.querySelector<HTMLElement>('input[type="radio"]:checked:not(:disabled), input[type="radio"]:not(:disabled)'))?.focus({ preventScroll: true })
  }, [step])
  useLayoutEffect(() => {
    if (scene.openingSource === 'card' && card.data && !selectedOpening) patch({ scene: { ...scene, openingSource: openings.length ? 'card' : 'skip', openingIndex: openings[0]?.index ?? 0 } })
  }, [card.data, scene.openingSource, scene.openingIndex])
  const selectedIds = (kind: AssetKind) => {
    if (kind === 'lorebook') return bookIds
    const selected = resources[resourceKey[kind]]
    return Array.isArray(selected) ? selected.map(item => item.id) : selected ? [selected.id] : []
  }
  const pendingCard = !!resources.card && !card.data
  const cardName = card.data?.asset.name ?? uiT(resources.card ? (card.error ? '角色暂不可用' : '读取中…') : '自由对话')
  const resourceError = card.error ?? persona.error ?? defaults.error
  const invalidOpening = scene.openingSource === 'custom' ? !scene.openingText?.trim() : scene.openingSource === 'card' && !selectedOpening
  const bookCount = bookIds.length
  return <EditorForm className="new-story-wizard" busy={busy} onSubmit={() => step === 'assets' ? setStep('opening') : onStart()}>
    <nav className="new-story-steps" aria-label={uiT('创建步骤')}>
      <Button tone="quiet" aria-current={step === 'assets' ? 'step' : undefined} onClick={() => setStep('assets')}><span className="step-number">{step === 'opening' ? <CheckIcon size={13} /> : '1'}</span>{uiT('选择资料')}</Button><span className="step-connector" />
      <Button tone="quiet" aria-current={step === 'opening' ? 'step' : undefined} onClick={() => setStep('opening')}><span className="step-number">2</span>{uiT('确认开场')}</Button>
    </nav>
    <div ref={scroll} className="new-story-step-content" key={step}>
      {step === 'assets' ? <div className="new-story-assets">
        <div className="new-story-catalog">{<TabGroup label={uiT('资料类型')} value={kinds.includes(tab) ? tab : kinds[0]!} onChange={value => setTab(value as AssetKind)} orientation={vertical ? 'vertical' : 'horizontal'} items={kinds.map(kind => ({ value: kind, label: uiT(assetLabels[kind]) }))}>
          <AssetSelection key={tab} kind={kinds.includes(tab) ? tab : kinds[0]!} ids={selectedIds(kinds.includes(tab) ? tab : kinds[0]!)} onChange={ids => select(kinds.includes(tab) ? tab : kinds[0]!, ids)} multiple={tab === 'lorebook' || tab === 'writingStyle'} disabled={busy || tab === 'lorebook' && pendingCard} autoFocus={vertical} />
        </TabGroup>}</div>
        <aside className="new-story-selection" aria-label={uiT('本次会话')}>
          <h3>{uiT('本次会话')}</h3>
          <div className="new-story-character">{card.data?.asset.avatarFileId ? <ContentImage src={`/api/files/${card.data.asset.avatarFileId}/content`} alt="" /> : <span className="new-story-character-placeholder"><UserRound size={28} strokeWidth={1.3} /></span>}<strong>{cardName}</strong></div>
          {card.data && <p className="new-story-card-description">{String(card.data.asset.data.description ?? card.data.asset.data.scenario ?? '')}</p>}
          {!!associated.length && <Check checked={associatedCount === associated.length} indeterminate={associatedCount > 0 && associatedCount < associated.length} label={uiT('带上关联世界书')} help={associated.map(book => book.name).join('、')} disabled={busy} onChange={event => onChange(event.target.checked
            ? { ...value, includeAssociatedLorebooks: true }
            : selectLorebooks(value, bookIds.filter(id => !associated.some(book => book.id === id)), associated))} />}
          <div className="new-story-resource-summary">{bookCount > 0 && <p>{uiT('世界书')}<strong>{uiT('%{count} 本', { count: bookCount })}</strong></p>}{(['persona', 'preset', 'writingStyle'] as const).flatMap(kind => selectedIds(kind).map(id => <ResourceSummary key={id} id={id} kind={kind} />))}</div>
          <p className="new-story-selection-hint">{uiT('人设、预设与文风都可以按需调整。')}</p>
          <Button tone="quiet" className="new-story-defaults" disabled={!defaults.data} onClick={() => { if (defaults.data) patch({ resources: { ...resources,
            persona: { id: defaults.data.defaults.persona },
            preset: { id: defaults.data.defaults.preset },
            writingStyles: [{ id: defaults.data.defaults.writingStyle }],
          } }) }}>{uiT('恢复默认偏好')}</Button>
        </aside>
      </div> : <NewStoryOpening scene={scene} card={card.data?.asset} userName={persona.data?.asset.name ?? uiT('我')} compatMvu={(profile.variables?.enabled ?? true) && (profile.variables?.mvu ?? true)} onChange={scene => patch({ scene })} />}
      {pendingCard && card.isPending && <Loading label={uiT('正在读取角色与关联资料…')} />}
      <ErrorNotice source={error ? 'action' : 'read'} error={error ?? resourceError} retry={!error && resourceError ? () => { if (card.error) void card.refetch(); if (persona.error) void persona.refetch(); if (defaults.error) void defaults.refetch() } : undefined} retrying={card.isFetching || persona.isFetching || defaults.isFetching} />
    </div>
    <footer className="new-story-footer"><div className="new-story-footer-context"><strong>{cardName}</strong><span>{step === 'assets' ? uiT('下一步预览开场') : uiT('创建后即可接着对话')}</span></div><div className="new-story-footer-actions">
      {step === 'opening' && <Button tone="quiet" onClick={() => setStep('assets')}><ArrowLeft size={15} />{uiT('上一步')}</Button>}
      <Button tone="quiet" onClick={done}>{uiT('返回输入')}</Button>
      <Button tone="primary" type="submit" disabled={busy || pendingCard || !!card.error || step === 'opening' && !!invalidOpening}>{busy ? uiT('正在创建…') : step === 'assets' ? <>{uiT('继续')}<ArrowRight size={15} /></> : <>{uiT('开始会话')}<ArrowRight size={15} /></>}</Button>
    </div></footer>
  </EditorForm>
}
function ResourceSummary({ id, kind }: { id: string; kind: AssetKind }) {
  const asset = useAsset(id)
  return <p><span>{uiT(assetLabels[kind])}</span><strong>{asset.data?.asset.name ?? (asset.error ? uiT('资料已不可用') : uiT('读取中…'))}</strong></p>
}
