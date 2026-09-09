import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { Eye, ListOrdered, Plus, RotateCcw } from 'lucide-react'
import type { StoryProfile } from '../../../../../packages/rp-core/src/types.ts'
import { canIdlePromptSlot, normalizePromptBuild, promptDocument, promptMaterials, visiblePromptSlots, type PromptBuild, type PromptInspection } from '../../../../../packages/rp-core/src/context/preview.ts'
import { api } from '../../lib/api.ts'
import { Button, Empty, ErrorNotice, Loading, Menu, MenuItem, TabGroup } from '../../components/ui.tsx'
import { useMediaQuery } from '../../lib/use-media-query.ts'
import { formatPromptCount, PromptGroupCard, PromptIcon, promptTones } from './prompt/cards.tsx'
import { usePromptDrag } from './prompt/drag.ts'
import { PromptContentEditor } from './prompt/content-editor.tsx'
import { PromptPreviewPane } from './prompt/preview-pane.tsx'
import './prompt/workbench.css'

interface Props {
  storyId: string; profile: StoryProfile; storyRevision: number; dirty: boolean
  onChange: (build: PromptBuild | undefined) => void; saving: boolean; disabled: boolean; saveError: Error | null
}
export function PromptEditor(props: Props) {
  const language = useUiLanguage()
  const { storyId, profile, onChange } = props
  const materialProfile = JSON.stringify({ ...profile, contextBuild: undefined })
  // This POST only computes a preview. It belongs to read recovery, never to save retries.
  const query = useQuery({ queryKey: ['prompt-inspection', storyId, props.storyRevision, materialProfile], enabled: !props.disabled,
    queryFn: ({ signal }) => api<PromptInspection>(`/stories/${storyId}/context-preview`, 'POST', { profile: JSON.parse(materialProfile) }, signal),
    placeholderData: keepPreviousData, gcTime: 0, staleTime: Infinity, refetchOnWindowFocus: false,
  })
  const { data: inspection, error, isFetching: loading } = query
  const notice = <ErrorNotice source="read" error={error} retry={() => void query.refetch()} retrying={loading} />
  const prepared = useMemo(() => {
    if (!inspection) return null
    try { return { build: normalizePromptBuild(profile.contextBuild, inspection.catalog), error: null } }
    catch (reason) { return { build: null, error: reason instanceof Error ? reason : new Error(uiT("资料顺序无效。")) } }
  }, [inspection, profile.contextBuild, language])
  if (error && !inspection) return notice
  if (!inspection || !prepared) return props.disabled ? <Empty title={uiT("回复生成中")}>{uiT("回复完成后可查看和调整下次回复的资料。")}</Empty> : <Loading label={uiT("正在整理下次回复的资料…")} />
  if (!prepared.build) return <div className="stack"><ErrorNotice error={prepared.error} /><p>{uiT("当前布局包含无效设置。恢复必需资料只会将始终使用的分组重新启用，其他顺序与内容保留。")}</p><div className="form-actions">
    <Button onClick={() => onChange({ ...profile.contextBuild!, slots: profile.contextBuild!.slots.map(slot => canIdlePromptSlot(slot, inspection.catalog) ? slot : { ...slot, idle: false }) })}>{uiT("恢复必需资料")}</Button>
    <Button onClick={() => onChange(undefined)}>{uiT("恢复默认顺序")}</Button>
  </div></div>
  return <>{notice}<PromptCanvas {...props} inspection={inspection} build={prepared.build} refreshing={loading} refresh={() => void query.refetch()} /></>
}

function PromptCanvas({ storyId, profile, dirty, build, inspection, onChange, saving, disabled, saveError, refresh, refreshing }: Props & { build: PromptBuild; inspection: PromptInspection; refresh: () => void; refreshing: boolean }) {
  useUiLanguage()
  const mobile = useMediaQuery('(max-width: 900px)')
  const root = useRef<HTMLDivElement>(null), mobileScroll = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<'arrange' | 'preview'>('arrange'), [mode, setMode] = useState<'cards' | 'plain'>('cards'), [editing, setEditing] = useState<string | null>(null)
  const blocked = disabled || saving || refreshing, drag = usePromptDrag({ root, build, catalog: inspection.catalog, change: onChange, disabled: blocked })
  const materials = useMemo(() => promptMaterials(build, inspection), [build, inspection])
  const document = useMemo(() => promptDocument(build, inspection), [build, inspection])
  const visible = visiblePromptSlots(build, inspection.catalog, materials, drag.drag?.item.kind === 'source')
  const idle = build.slots.filter(slot => slot.idle), selected = build.slots.find(slot => slot.id === editing)
  const invalidName = build.slots.some(slot => slot.id.startsWith('custom-') && !slot.label.trim())
  useLayoutEffect(() => { mobileScroll.current?.scrollTo({ top: 0, behavior: 'instant' }) }, [mobile, view, editing])
  const edit = (id: string) => { setEditing(id); setView('arrange') }
  const add = () => {
    const id = 'custom-' + crypto.randomUUID()
    onChange({ ...build, slots: [...build.slots.filter(slot => !slot.idle), { id, label: uiT("自定义资料"), sourceIds: [], sectionTag: true }, ...idle] }); edit(id)
  }
  const reset = () => { onChange(undefined); setEditing(null) }
  const card = (slot: PromptBuild['slots'][number], index: number) => <PromptGroupCard key={slot.id} slot={slot} index={index} build={build} catalog={inspection.catalog}
    materials={materials} visible={visible} selected={editing === slot.id} disabled={blocked} drag={drag} change={onChange} edit={edit} />
  const endDrop = (area: 'active' | 'idle') => drag.drag?.item.kind === 'slot' && drag.drag.target?.area === area && drag.drag.target.beforeId === null
  const idlePanel = <aside className="prompt-idle" data-prompt-area="idle" data-drop-invalid={drag.drag?.target?.area === 'idle' && !drag.drag.target.allowed || undefined}>
    <header><div><small>{uiT("暂不使用")}</small><h3>{uiT("闲置区")}</h3></div><span>{idle.length} {uiT(" 组")}</span></header>
    <p className="prompt-help">{mobile ? uiT('在分组菜单中选择「移入闲置区」可暂停使用，内容会保留。') : uiT("拖到这里的分组会保留，但不参与下次回复。可拖回中间恢复。")}</p>
    <div className="prompt-idle-list" data-prompt-scroll={!mobile || undefined} data-drop-end={endDrop('idle') || undefined}>
      {idle.length ? idle.map(card) : <div className="prompt-idle-empty"><strong>{drag.drag?.target?.area === 'idle' ? drag.drag.target.allowed ? uiT("松开放入闲置区") : uiT("这个分组始终使用") : uiT("暂无闲置分组")}</strong>{!mobile && <span>{uiT("拖动分组名称到这里")}</span>}</div>}
    </div>
  </aside>
  const arrangement = <section className="prompt-arrangement" data-prompt-area="active">
    <header><div><small>{uiT("调整顺序")}</small><h3>{uiT("写作上下文顺序")}</h3></div><Button disabled={blocked || build.slots.length >= 64} onClick={add}><Plus size={15} />{uiT("添加分组")}</Button></header>
    <p className="prompt-help">{mobile ? uiT('拖动左侧手柄调整顺序，或使用分组菜单。点击上方「预览」查看完整上下文。') : uiT("拖动手柄调整顺序，拖动资料图标更换分组。会话总结、对话历史和当前输入始终启用。")}</p>
    <div className="prompt-legend">{promptTones.map(([tone, label]) => <span key={tone}><PromptIcon tone={tone} />{uiT(label)}</span>)}</div>
    <div className="prompt-active-list" data-prompt-scroll={!mobile || undefined} data-drop-end={endDrop('active') || undefined}>{visible.map(card)}</div>
  </section>
  const editor = selected && <PromptContentEditor slot={selected} build={build} disabled={blocked} mobile={mobile} onChange={onChange} back={() => setEditing(null)} />
  const preview = <PromptPreviewPane storyId={storyId} profile={profile} build={build} document={document} blocked={blocked} mobile={mobile} mode={mode} onModeChange={setMode} onChange={onChange} />
  return <div className="prompt-workbench" ref={root} onClickCapture={event => { if (event.detail > 0 && drag.consumeClick(event.target)) { event.preventDefault(); event.stopPropagation() } }}>
    <div className="sr-only" role="status" aria-live="polite">{drag.announcement}</div>
    {mobile ? <TabGroup className="prompt-mobile-tabs" value={view} onChange={setView} label={uiT('写作 Prompt 视图')}
      items={[{ value: 'arrange', label: uiT('编排'), icon: <ListOrdered size={16} /> }, { value: 'preview', label: uiT('预览'), icon: <Eye size={16} /> }]}>
      <div className="prompt-mobile-scroll" data-prompt-scroll ref={mobileScroll}>{view === 'preview' ? preview : editor || <>{arrangement}{idlePanel}</>}</div>
    </TabGroup> : <div className="prompt-grid">{idlePanel}{arrangement}{editor || preview}</div>}
    <ErrorNotice error={saveError} />
    <footer className="prompt-footer">
      <div aria-live="polite">{uiT("回复资料 ")}{formatPromptCount(document.characters)} {uiT(" 字")}<span>{disabled ? uiT(" · 回复生成中") : saving ? uiT(" · 保存中…") : refreshing ? uiT(" · 正在刷新资料…") : invalidName ? uiT(" · 请填写分组名称") : dirty ? uiT(" · 修改尚未保存") : uiT(" · 已保存")}</span></div>
      <div className="prompt-footer-actions">
        {mobile ? <Menu label={uiT('Prompt 操作')}>
          <MenuItem disabled={blocked} onSelect={refresh}>{uiT("刷新资料")}</MenuItem>
          <MenuItem disabled={blocked} onSelect={reset}>{uiT("恢复默认顺序")}</MenuItem>
        </Menu> : <><Button tone="quiet" disabled={blocked} onClick={refresh}>{uiT("刷新资料")}</Button><Button tone="quiet" disabled={blocked} onClick={reset}><RotateCcw size={13} />{uiT("恢复默认顺序")}</Button></>}
        <Button tone="primary" type="submit" disabled={blocked || !dirty || invalidName}>{saving ? uiT("保存中…") : uiT("保存更改")}</Button>
      </div>
    </footer>
    {drag.drag && createPortal(<div className="prompt-drag-ghost" style={{ left: drag.drag.x - drag.drag.offsetX, top: drag.drag.y - drag.drag.offsetY, width: Math.max(150, drag.drag.width) }}><strong>{drag.drag.label}</strong><span>{drag.drag.target && !drag.drag.target.allowed ? uiT("必须始终使用") : drag.drag.item.kind === 'source' ? uiT("移动资料") : uiT("移动分组")}</span></div>, globalThis.document.body)}
  </div>
}
