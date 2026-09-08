import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { AssetKind, AssetRecord, JsonObject, JsonValue } from '../../../../../packages/rp-core/src/types.ts'
import { api, queryClient, useAction, useAsset } from '../../lib/api.ts'
import { assetLabels } from '../../components/selectors.tsx'
import { Button, Check, ErrorNotice, Field, Input, Loading, Modal, Select, Textarea, TextListInput } from '../../components/ui.tsx'
import { CancelButton, EditorForm } from '../../components/form-guard.tsx'
import { PersonaDescription } from './persona-description.tsx'
import { consolidatePersonaDescription } from './persona-draft.ts'
import { AvatarPicker } from './avatar-picker.tsx'
import { EntryEditor } from './entries.tsx'

const fields: Record<AssetKind, string[]> = {
  character: ['name', 'description', 'personality', 'scenario', 'firstMessage', 'messageExample', 'creatorNotes', 'creator', 'characterVersion', 'nickname', 'tags', 'alternateGreetings', 'groupOnlyGreetings', 'extensions', 'acceptedPromptPaths'],
  persona: ['name', 'description', 'personality', 'scenario', 'firstMessage', 'tags'], preset: ['name', 'description', 'fields'], writingStyle: ['name', 'description', 'content'], lorebook: ['name', 'entries', 'scanDepth', 'recursiveScanning'],
}
const loreFields = ['id', 'name', 'content', 'level', 'semanticKey', 'keys', 'secondaryKeys', 'stateCondition', 'enabled', 'constant', 'caseSensitive', 'recursive', 'order', 'position', 'insertionPosition', 'depth', 'probability']
function editable(kind: AssetKind, data?: JsonObject): JsonObject {
  const source = data ?? { name: '', description: '', ...(kind === 'lorebook' ? { entries: [] } : kind === 'preset' ? { fields: [] } : kind === 'writingStyle' ? { content: '' } : {}) }
  const body = Object.fromEntries(fields[kind].filter(key => source[key] !== undefined).map(key => [key, structuredClone(source[key]!)])) as JsonObject
  if (kind === 'lorebook' && Array.isArray(body.entries)) body.entries = body.entries.map(entry => Object.fromEntries(Object.entries(entry as JsonObject).filter(([key]) => loreFields.includes(key))))
  return kind === 'persona' ? consolidatePersonaDescription(body) : body
}
export async function refreshAssets() { await Promise.all([queryClient.invalidateQueries({ queryKey: ['assets'] }), queryClient.invalidateQueries({ queryKey: ['asset'] }), queryClient.invalidateQueries({ queryKey: ['defaults'] })]) }

export function AssetEditorDialog({ id, kind, onClose }: { id: string | null; kind: AssetKind; onClose: () => void }) {
  return <Modal open={id !== null} onOpenChange={open => { if (!open) onClose() }} title={uiT(`${id === 'new' ? '创建' : '编辑'}${assetLabels[kind]}`)} size="editor" className={kind === 'persona' ? 'persona-editor-modal' : undefined}>{id && <AssetEditorSurface key={`${kind}:${id}`} id={id} kind={kind} done={onClose} />}</Modal>
}
function AssetEditorSurface({ id, kind, done }: { id: string; kind: AssetKind; done: () => void }) {
  useUiLanguage()
  const query = useAsset(id === 'new' ? undefined : id)
  if (id !== 'new' && query.isPending) return <Loading />
  return <><ErrorNotice error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />{(id === 'new' || query.data) && <AssetEditor asset={query.data?.asset} kind={kind} done={done} />}</>
}
function AssetEditor({ asset, kind, done }: { asset?: AssetRecord; kind: AssetKind; done: () => void }) {
  useUiLanguage()
  const [record, setRecord] = useState(asset), [value, setValue] = useState(() => editable(kind, asset?.data)), [avatar, setAvatar] = useState<File | null | undefined>(), [advanced, setAdvanced] = useState(false), [raw, setRaw] = useState(''), action = useAction()
  const dirty = avatar !== undefined || (advanced ? raw !== JSON.stringify(editable(kind, record?.data), null, 2) : JSON.stringify(value) !== JSON.stringify(editable(kind, record?.data)))
  const set = (key: string, next: JsonValue | undefined) => setValue(current => { const value = { ...current }; if (next === undefined) delete value[key]; else value[key] = next; return value })
  const textFields: [string, string][] = kind === 'character' ? [['description', uiT("角色描述")], ['personality', uiT("性格")], ['scenario', uiT("背景与场景")], ['firstMessage', uiT("默认开场")], ['messageExample', uiT("示例对话")], ['creatorNotes', uiT("作者说明")]]
    : kind === 'persona' ? [['description', uiT("描述")]] : kind === 'writingStyle' ? [['description', uiT("说明")], ['content', uiT("文风指令")]] : kind === 'preset' ? [['description', uiT("说明")]] : []
  const descriptionRows = kind === 'preset' || kind === 'writingStyle' ? 2 : 3
  const compactMeta = kind === 'preset' || kind === 'writingStyle'
  const hasAvatar = kind === 'character' || kind === 'persona'
  const nameField = <Field label={uiT('名称')}><Input autoFocus required value={String(value.name ?? '')} onChange={event => set('name', event.target.value)} /></Field>
  const quarantined = (Array.isArray(asset?.data.quarantinedPrompts) ? asset.data.quarantinedPrompts : []) as { path: string; value: string }[]
  return <EditorForm className="asset-editor stack" dirty={dirty} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => {
    const draft = advanced ? JSON.parse(raw) : value
    const data = kind === 'persona' ? consolidatePersonaDescription(draft) : draft
    const saved = await api<{ asset: AssetRecord }>(record ? `/assets/${record.id}` : '/assets', record ? 'PUT' : 'POST', record ? { expectedRevision: record.revision, data } : { kind, data })
    setRecord(saved.asset); setValue(editable(kind, saved.asset.data))
    if (avatar !== undefined) {
      try {
        if (avatar) { const body = new FormData(); body.append('file', avatar); const result = await api<{ asset: AssetRecord }>(`/assets/${saved.asset.id}/avatar?expectedRevision=${saved.asset.revision}`, 'PUT', body); setRecord(result.asset) }
        else { const result = await api<{ asset: AssetRecord }>(`/assets/${saved.asset.id}/avatar`, 'DELETE', { expectedRevision: saved.asset.revision }); setRecord(result.asset) }
        setAvatar(undefined)
      } catch (error) { await refreshAssets(); throw new Error(uiT("资料文字已保存，头像未更新：%{v0}", { v0: error instanceof Error ? error.message : uiT("请重新选择图片。") })) }
    }
    await refreshAssets(); done()
  }) }}>
    <div className="section-heading asset-editor-note"><p className="muted">{asset ? uiT("共享资料 · 修改用于各会话的后续回复") : uiT("保存到资料库，可在其他会话中使用")}</p><Button onClick={() => { if (advanced) { try { const parsed = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object'); for (const key of ['tags', 'alternateGreetings', 'acceptedPromptPaths']) if (parsed[key] !== undefined && (!Array.isArray(parsed[key]) || parsed[key].some((item: unknown) => typeof item !== 'string'))) throw new Error('string array'); for (const key of ['entries', 'fields']) if (parsed[key] !== undefined && (!Array.isArray(parsed[key]) || parsed[key].some((item: unknown) => !item || typeof item !== 'object' || Array.isArray(item)))) throw new Error('object array'); for (const entry of parsed.entries ?? []) for (const key of ['keys', 'secondaryKeys']) if (entry[key] !== undefined && (!Array.isArray(entry[key]) || entry[key].some((item: unknown) => typeof item !== 'string'))) throw new Error('keyword array'); setValue(kind === 'persona' ? consolidatePersonaDescription(parsed) : parsed); setAdvanced(false) } catch { void action.run(async () => { throw new Error(uiT("请输入资料对象；标签、其他开场和条目关键词应为文字数组，条目应为对象数组。请修正后切换。")) }) } } else { setRaw(JSON.stringify(value, null, 2)); setAdvanced(true) } }}>{advanced ? uiT("切换到表单") : uiT("高级 JSON")}</Button></div>
    {hasAvatar && <section className="avatar-editor">
      <AvatarPicker kind={kind} currentFileId={record?.avatarFileId} value={avatar} onChange={setAvatar} disabled={action.busy} />
      <div className="avatar-editor-fields">{!advanced && nameField}</div>
    </section>}
    {advanced ? <Field label={uiT("可编辑字段 JSON")}><Textarea className="code-input" rows={25} value={raw} onChange={event => setRaw(event.target.value)} /></Field> : <>{!hasAvatar && <div className={compactMeta ? 'asset-editor-meta' : undefined}>{nameField}{compactMeta && <Field label={uiT('说明')}><Textarea rows={2} value={String(value.description ?? '')} onChange={event => set('description', event.target.value)} /></Field>}</div>}{textFields.filter(([key]) => !compactMeta || key !== 'description').map(([key, label]) => kind === 'persona' && key === 'description' ? <PersonaDescription key={key} value={String(value[key] ?? '')} onChange={value => set(key, value)} /> : <Field label={label} key={key}><Textarea rows={key === 'description' ? descriptionRows : key === 'content' ? 6 : 4} value={String(value[key] ?? '')} onChange={event => set(key, event.target.value)} required={kind === 'writingStyle' && key === 'content'} /></Field>)}{kind === 'character' && <Field label={uiT("标签")} help={uiT("以逗号分隔")}><TextListInput value={(value.tags ?? []) as string[]} onChange={tags => set('tags', tags)} /></Field>}{kind === 'character' && <section className="stack"><h3>{uiT("其他开场")}</h3>{(Array.isArray(value.alternateGreetings) ? value.alternateGreetings : []).map((text, index) => <div className="stack" key={index}><Field label={uiT("开场 %{v0}", { v0: index + 2 })}><Textarea value={String(text)} onChange={event => set('alternateGreetings', (value.alternateGreetings as JsonValue[]).map((item, i) => i === index ? event.target.value : item))} /></Field><Button tone="quiet" onClick={() => set('alternateGreetings', (value.alternateGreetings as JsonValue[]).filter((_, i) => i !== index))}>{uiT("移除这个开场")}</Button></div>)}<Button onClick={() => set('alternateGreetings', [...(Array.isArray(value.alternateGreetings) ? value.alternateGreetings : []), ''])}><Plus size={15} />{uiT("添加开场")}</Button></section>}{(kind === 'preset' || kind === 'lorebook') && <EntryEditor kind={kind} disabled={action.busy} entries={(value[kind === 'preset' ? 'fields' : 'entries'] ?? []) as JsonObject[]} onChange={entries => set(kind === 'preset' ? 'fields' : 'entries', entries)} />}</>}
    {!advanced && kind === 'lorebook' && <details><summary>{uiT('世界书扫描设置')}</summary><div className="stack"><Field label={uiT('扫描深度')} help={uiT('留空使用默认范围；填写非负整数。')}><Input type="number" min={0} step={1} value={value.scanDepth === undefined ? '' : Number(value.scanDepth)} onChange={event => set('scanDepth', event.target.value === '' ? undefined : Number(event.target.value))} /></Field><Check label={uiT('允许递归扫描')} checked={value.recursiveScanning !== false} onChange={event => set('recursiveScanning', event.target.checked)} /></div></details>}
    {!advanced && kind === 'character' && <details><summary>{uiT('作者与版本')}</summary><div className="form-grid">{[['creator', uiT('作者')], ['characterVersion', uiT('角色版本')], ['nickname', uiT('别名')]].map(([key, label]) => <Field key={key} label={label!}><Input value={String(value[key!] ?? '')} onChange={event => set(key!, event.target.value)} /></Field>)}</div></details>}
    {quarantined.length > 0 && !advanced && <section className="trust-section stack"><h3>{uiT("导入卡片中的附加提示")}</h3><p className="muted">{uiT("仅勾选你希望作为提示词使用的内容。未勾选的项目不会进入生成上下文。")}</p>{quarantined.map(item => <details key={item.path}><summary>{item.path}</summary><pre>{item.value}</pre><Check label={uiT("将这项内容作为提示词使用")} checked={Array.isArray(value.acceptedPromptPaths) && value.acceptedPromptPaths.includes(item.path)} onChange={event => { const selected = (value.acceptedPromptPaths ?? []) as string[]; set('acceptedPromptPaths', event.target.checked ? [...selected, item.path] : selected.filter(path => path !== item.path)) }} /></details>)}</section>}
    <ErrorNotice error={action.error} /><div className="form-actions sticky-actions"><span className="settings-save-status" role="status">{dirty ? uiT("有未保存的更改") : ''}</span><CancelButton onCancel={done} /><Button tone="primary" type="submit" disabled={action.busy}>{action.busy ? uiT("正在保存…") : uiT("保存资料")}</Button></div>
  </EditorForm>
}
