import { uiT, useUiLanguage } from '../lib/i18n.ts'
import { useId, useState, type ReactNode } from 'react'
import { Search, X, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, Eye } from 'lucide-react'
import type { AssetKind } from '../../../../packages/rp-core/src/types.ts'
import { useAsset, useAssetCatalog } from '../lib/api.ts'
import { Button, Check, Empty, ErrorNotice, Field, IconButton, Input, Loading, Modal } from './ui.tsx'
import { AssetDetailsById } from './asset-details.tsx'

export const assetLabels: Record<AssetKind, string> = { character: '角色卡', lorebook: '世界书', persona: '我的人设', preset: '创作预设', writingStyle: '文风' }
interface SelectionProps { kind: AssetKind; ids: string[]; onChange: (ids: string[]) => void; multiple?: boolean; disabled?: boolean }
function SelectedAsset({ id, disabled, onRemove, children }: { id: string; disabled: boolean; onRemove: () => void; children?: ReactNode }) {
  useUiLanguage()
  const query = useAsset(id), name = query.data?.asset.name ?? (query.error ? uiT('资料已不可用') : uiT('读取中…'))
  return <span className="selected-asset"><span>{name}</span>{children}<IconButton disabled={disabled} label={uiT('取消选择：%{name}', { name })} onClick={onRemove}><X size={14} /></IconButton></span>
}
function SelectedAssets({ ids, multiple, disabled = false, onChange, children }: Omit<SelectionProps, 'kind'> & { children?: ReactNode }) {
  return <div className="selected-assets">{ids.map((id, index) => <SelectedAsset key={id} id={id} disabled={disabled} onRemove={() => onChange(ids.filter(value => value !== id))}>
    {multiple && <><IconButton label={uiT('上移资料')} disabled={disabled || index === 0} onClick={() => { const next = [...ids]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; onChange(next) }}><ArrowUp size={13} /></IconButton><IconButton label={uiT('下移资料')} disabled={disabled || index === ids.length - 1} onClick={() => { const next = [...ids]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; onChange(next) }}><ArrowDown size={13} /></IconButton></>}
  </SelectedAsset>)}{children}</div>
}
export function AssetPicker(props: SelectionProps) {
  useUiLanguage()
  const [open, setOpen] = useState(false)
  return <div className="asset-picker"><SelectedAssets {...props}><Button disabled={props.disabled} onClick={() => setOpen(true)}>{props.ids.length ? uiT('更改') : uiT('选择')}{uiT(assetLabels[props.kind])}</Button></SelectedAssets>
    <Modal size="form" open={open} onOpenChange={setOpen} title={uiT('选择%{v0}', { v0: uiT(assetLabels[props.kind]) })}>
      {open && <div className="stack"><AssetSelection {...props} onSelect={props.multiple ? undefined : () => setOpen(false)} /><div className="form-actions sticky-actions"><span className="settings-save-status" role="status">{uiT('已选择 %{count} 份', { count: props.ids.length })}</span><Button tone="primary" onClick={() => setOpen(false)}>{uiT('完成选择')}</Button></div></div>}
    </Modal>
  </div>
}
/** The same catalog works directly inside a binding form, without another chooser dialog. */
export function AssetSelection({ kind, ids, onChange, multiple = false, disabled = false, onSelect, autoFocus = true }: SelectionProps & { onSelect?: () => void; autoFocus?: boolean }) {
  useUiLanguage()
  const group = useId(), [search, setSearch] = useState(''), [offset, setOffset] = useState(0), [preview, setPreview] = useState<string | null>(null)
  const query = useAssetCatalog(kind, search, offset)
  return <div className="asset-selection stack">
    <div className="search-field"><Search size={17} /><Input autoFocus={autoFocus} aria-label={uiT('搜索资料')} placeholder={uiT('按名称搜索')} value={search} onChange={event => { setSearch(event.target.value); setOffset(0) }} /></div>
    {multiple && ids.length > 0 && <SelectedAssets ids={ids} multiple disabled={disabled} onChange={onChange} />}
    <ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />{query.isPending && <Loading />}
    <div className="pick-list">{!multiple && <div className="asset-pick-row"><Check type="radio" name={group} label={uiT('不使用%{kind}', { kind: uiT(assetLabels[kind]) })} checked={!ids.length} disabled={disabled} onChange={() => { onChange([]); onSelect?.() }} /></div>}
      {query.data?.assets.map(asset => <div className="asset-pick-row" key={asset.id}><Check type={multiple ? 'checkbox' : 'radio'} name={multiple ? undefined : group} label={asset.name} help={asset.description} checked={ids.includes(asset.id)} disabled={disabled || kind === 'writingStyle' && ids.length >= 16 && !ids.includes(asset.id)} onChange={event => {
        onChange(multiple ? event.target.checked ? [...ids, asset.id] : ids.filter(id => id !== asset.id) : [asset.id]); onSelect?.()
      }} /><IconButton label={uiT('查看%{v0}详情', { v0: asset.name })} onClick={() => setPreview(asset.id)}><Eye size={16} /></IconButton></div>)}
    </div>
    {!query.error && query.data?.total === 0 && <Empty title={search ? uiT('没有找到资料') : uiT('还没有可选资料')} action={search ? <Button onClick={() => setSearch('')}>{uiT('清空搜索')}</Button> : undefined}>{uiT('可以在资料库中创建或导入。')}</Empty>}
    {query.data && query.data.total > 50 && <div className="pagination"><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}><ChevronLeft size={16} />{uiT('上一页')}</Button><span>{query.data.total} {uiT('份资料')}</span><Button disabled={query.data.nextOffset == null} onClick={() => setOffset(query.data!.nextOffset!)}>{uiT('下一页')}<ChevronRight size={16} /></Button></div>}
    <Modal open={preview !== null} onOpenChange={open => { if (!open) setPreview(null) }} title={uiT('%{v0}详情', { v0: uiT(assetLabels[kind]) })} size="editor">{preview && <AssetDetailsById id={preview} />}</Modal>
  </div>
}
export { ModelPicker } from './model-picker.tsx'
