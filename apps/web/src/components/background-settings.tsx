import { ContentImage } from './content-image.tsx'
import { useId, useRef, useState } from 'react'
import { ArrowUp, Check, ImageOff, ImagePlus, Images, Pencil, Trash2, Upload } from 'lucide-react'
import { BACKGROUND_INTENSITY, BACKGROUND_PRESETS, MAX_BACKGROUNDS, MAX_BACKGROUND_UPLOAD_BYTES, findBackground, type BackgroundChoice, type BackgroundImage, type BackgroundPreset, type BackgroundSnapshot } from '../../../../packages/protocol/src/backgrounds.ts'
import { api, useAction } from '../lib/api.ts'
import { backgroundUrl, cacheBackgrounds, useBackgrounds } from '../lib/backgrounds.ts'
import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { Button, ErrorNotice, Field, IconButton, Input, Loading, Modal } from './ui.tsx'
import { EditorForm, CancelButton } from './form-guard.tsx'
import { SettingRow, SettingsGroup } from './settings-layout.tsx'
import { SettingSlider } from './settings-controls.tsx'
import { BackgroundSurface } from './app-background.tsx'

export function BackgroundSettings() {
  useUiLanguage()
  const query = useBackgrounds(), [open, setOpen] = useState(false)
  const current = findBackground(query.data, query.data?.selectedId)
  return <>
    <SettingsGroup title={uiT('背景图片')}>
      {query.isPending ? <Loading /> : query.error ? <ErrorNotice error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} /> : <SettingRow
        label={<span className="background-current">{current ? <ContentImage src={backgroundUrl(current.id, true)} alt="" /> : <span className="background-current-empty"><ImageOff size={20} /></span>}<span>{backgroundName(current)}</span></span>}
        help={uiT('在界面最底层显示，所有页面共用。')}>
        <Button onClick={() => setOpen(true)}><Images size={16} />{uiT('管理背景')}</Button>
      </SettingRow>}
    </SettingsGroup>
    <Modal open={open} onOpenChange={setOpen} title={uiT('背景图片')} description={uiT('上传喜欢的图片，选择一张作为界面背景。')} size="editor" className="background-manager">
      {open && query.data && <BackgroundManager initial={query.data} done={() => setOpen(false)} />}
    </Modal>
  </>
}

function BackgroundManager({ initial, done }: { initial: BackgroundSnapshot; done: () => void }) {
  const [saved, setSaved] = useState(initial), [choice, setChoice] = useState<BackgroundChoice>({ selectedId: initial.selectedId, intensity: initial.intensity })
  const [edit, setEdit] = useState<{ image: BackgroundImage; kind: 'rename' | 'delete' } | null>(null)
  const upload = useRef<HTMLInputElement>(null), groupId = useId(), action = useAction()
  const dirty = choice.selectedId !== saved.selectedId || choice.intensity !== saved.intensity
  const selected = findBackground(saved, choice.selectedId)
  const accept = (snapshot: BackgroundSnapshot) => {
    setSaved(snapshot); cacheBackgrounds(snapshot)
    setChoice(current => current.selectedId && !findBackground(snapshot, current.selectedId) ? { ...current, selectedId: null } : current)
  }
  const refresh = async () => accept(await api<BackgroundSnapshot>('/settings/backgrounds'))
  const intake = (file: File | undefined) => {
    if (!file) return
    void action.run(async () => {
      if (!file.size || file.size > MAX_BACKGROUND_UPLOAD_BYTES) throw new Error(uiT('背景图片不能为空，且不能超过 10 MB。'))
      const form = new FormData(); form.append('file', file)
      const result = await api<BackgroundSnapshot & { uploadedId: string }>(`/settings/backgrounds?expectedRevision=${saved.revision}`, 'POST', form)
      accept(result); setChoice(current => ({ ...current, selectedId: result.uploadedId }))
    })
  }
  return <>
    <EditorForm className="background-form" dirty={dirty} busy={action.busy} onSubmit={() => void action.run(async () => {
      const snapshot = await api<BackgroundSnapshot>('/settings/backgrounds', 'PUT', { expectedRevision: saved.revision, ...choice })
      accept(snapshot); done()
    })}>
      <div className="background-preview">
        <BackgroundSurface key={choice.selectedId} value={choice} />
        <div className="background-preview-copy"><small>{uiT('效果预览')}</small><p>{uiT('让故事，在喜欢的风景里继续。')}</p><div>{uiT('接下来，你想怎么做？')}<span aria-hidden="true"><ArrowUp size={16} /></span></div></div>
      </div>
      <SettingsGroup className="background-strength"><SettingSlider label={uiT('背景强度')} value={choice.intensity} min={BACKGROUND_INTENSITY.min} max={BACKGROUND_INTENSITY.max} displayValue={`${choice.intensity}%`} onChange={intensity => setChoice(current => ({ ...current, intensity }))} /></SettingsGroup>
      <div className="background-library" role="radiogroup" aria-label={uiT('背景图片')}>
        <div className="background-library-heading"><h3>{uiT('推荐背景')}</h3></div>
        <div className="background-grid background-preset-grid">
          <BackgroundTile group={groupId} selected={choice.selectedId === null} choose={() => setChoice(current => ({ ...current, selectedId: null }))} />
          {BACKGROUND_PRESETS.map(image => <BackgroundTile key={image.id} group={groupId} image={image} selected={choice.selectedId === image.id} active={saved.selectedId === image.id} choose={() => setChoice(current => ({ ...current, selectedId: image.id }))} />)}
        </div>
        <div className="background-library-heading"><div><h3>{uiT('我的图片')}</h3><small>{uiT('已保存 %{count} / %{max} 张', { count: saved.images.length, max: MAX_BACKGROUNDS })}</small></div><Button disabled={saved.images.length >= MAX_BACKGROUNDS} onClick={() => upload.current?.click()}><Upload size={16} />{action.busy ? uiT('处理中…') : uiT('上传图片')}</Button></div>
        <input ref={upload} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={event => { intake(event.target.files?.[0]); event.target.value = '' }} />
        <p className="background-upload-hint">{uiT('JPG、PNG、WebP，每张不超过 10 MB。上传和图库管理立即保存，应用后更换背景。')}</p>
        <div className="background-grid">
          {saved.images.map(image => <BackgroundTile key={image.id} group={groupId} image={image} selected={choice.selectedId === image.id} active={saved.selectedId === image.id} choose={() => setChoice(current => ({ ...current, selectedId: image.id }))} rename={() => setEdit({ image, kind: 'rename' })} remove={() => setEdit({ image, kind: 'delete' })} />)}
          {!saved.images.length && <button type="button" className="background-add-tile" onClick={() => upload.current?.click()}><ImagePlus size={26} /><span>{uiT('上传第一张图片')}</span></button>}
        </div>
      </div>
      <ErrorNotice error={action.error} retry={() => void action.run(refresh)} />
      <div className="form-actions background-actions"><span>{backgroundName(selected)}</span><CancelButton onCancel={done} /><Button tone="primary" type="submit" disabled={!dirty}>{uiT('应用背景')}</Button></div>
    </EditorForm>
    <Modal open={!!edit} onOpenChange={open => { if (!open) setEdit(null) }} title={edit?.kind === 'rename' ? uiT('重命名背景') : uiT('删除背景图片')} size="compact">
      {edit && <BackgroundImageEdit key={`${edit.kind}:${edit.image.id}`} edit={edit} revision={saved.revision} accept={accept} refresh={refresh} done={() => setEdit(null)} />}
    </Modal>
  </>
}

function backgroundName(image: BackgroundImage | BackgroundPreset | undefined) { return image ? 'slug' in image ? uiT(image.name) : image.name : uiT('无背景') }

function BackgroundTile({ group, image, selected, active, choose, rename, remove }: { group: string; image?: BackgroundImage | BackgroundPreset; selected: boolean; active?: boolean; choose: () => void; rename?: () => void; remove?: () => void }) {
  const name = backgroundName(image)
  return <div className="background-tile">
    <label className="background-tile-choice"><input type="radio" name={group} aria-label={name} checked={selected} onChange={choose} value={image?.id ?? 'none'} />
      <span className="background-tile-picture">{image ? <ContentImage src={backgroundUrl(image.id, true)} alt="" loading="lazy" /> : <ImageOff size={24} />}{selected && <span className="background-tile-check"><Check size={14} /></span>}{active && <small>{uiT('使用中')}</small>}</span>
      <span className="background-tile-name" title={name}>{name}</span>
      {image && 'description' in image && <span className="background-tile-description">{uiT(image.description)}</span>}
    </label>
    {image && rename && remove && <div className="background-tile-actions"><small>{image.width} × {image.height}</small><IconButton label={uiT('重命名 %{name}', { name: image.name })} onClick={rename}><Pencil size={14} /></IconButton><IconButton label={uiT('删除 %{name}', { name: image.name })} onClick={remove}><Trash2 size={14} /></IconButton></div>}
  </div>
}

function BackgroundImageEdit({ edit, revision, accept, refresh, done }: { edit: { image: BackgroundImage; kind: 'rename' | 'delete' }; revision: number; accept: (value: BackgroundSnapshot) => void; refresh: () => Promise<void>; done: () => void }) {
  const [name, setName] = useState(edit.image.name), action = useAction(), renaming = edit.kind === 'rename'
  return <EditorForm className="stack" dirty={renaming && name !== edit.image.name} busy={action.busy} onSubmit={() => void action.run(async () => {
    const snapshot = await api<BackgroundSnapshot>(`/settings/backgrounds/${encodeURIComponent(edit.image.id)}`, renaming ? 'PATCH' : 'DELETE', { expectedRevision: revision, ...(renaming ? { name } : {}) })
    accept(snapshot); done()
  })}>
    {renaming ? <Field label={uiT('图片名称')}><Input autoFocus required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></Field> : <p>{uiT('删除“%{name}”后无法恢复。如果正在使用，将恢复无背景。', { name: edit.image.name })}</p>}
    <ErrorNotice error={action.error} retry={() => void action.run(refresh)} />
    <div className="form-actions"><CancelButton onCancel={done} /><Button type="submit" tone={renaming ? 'primary' : 'danger'} disabled={renaming && (!name.trim() || name === edit.image.name)}>{renaming ? uiT('保存名称') : uiT('删除图片')}</Button></div>
  </EditorForm>
}
