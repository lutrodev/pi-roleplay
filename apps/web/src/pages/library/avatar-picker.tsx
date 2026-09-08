import { ContentImage } from '../../components/content-image.tsx'
import { useEffect, useRef, useState } from 'react'
import { Camera, ImagePlus, RotateCcw, Trash2, UserRound } from 'lucide-react'
import { Button, Menu, MenuItem, MenuSeparator } from '../../components/ui.tsx'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'

export function AvatarPicker({ kind, currentFileId, value, onChange, disabled }: {
  kind: 'character' | 'persona'; currentFileId?: string | null; value: File | null | undefined
  onChange: (value: File | null | undefined) => void; disabled: boolean
}) {
  useUiLanguage()
  const input = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string>()
  useEffect(() => {
    if (!value) { setPreview(undefined); return }
    const url = URL.createObjectURL(value)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [value])
  const url = preview ?? (currentFileId && value !== null ? `/api/files/${currentFileId}/content` : undefined)
  const changed = value !== undefined
  const choose = () => input.current?.click()
  const label = uiT(kind === 'persona' ? '编辑人设头像' : '编辑角色图片')
  const image = <>
    {url ? <ContentImage src={url} alt={uiT(changed ? '待保存的头像' : '当前头像')} /> : <span className="avatar-picker-placeholder"><UserRound size={26} strokeWidth={1.3} /></span>}
    <span className="avatar-picker-caption">{url ? <Camera size={13} /> : <ImagePlus size={13} />}{uiT(url ? '更换' : value === null ? '已移除' : '上传')}</span>
    {changed && <span className="avatar-picker-pending" role="status"><span className="sr-only">{uiT('图片更改将在保存资料后生效')}</span></span>}
  </>
  const trigger = <Button tone="quiet" className="avatar-picker-frame" disabled={disabled} aria-label={label} title={value ? `${value.name} · ${uiT('保存后生效')}` : uiT('点击设置图片，支持 PNG、JPEG、WebP，最大 5 MB。')}>{image}</Button>
  return <div className={`avatar-picker avatar-picker-${kind}`}>
    <input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label={uiT('选择头像图片')} disabled={disabled} onChange={event => {
      const file = event.currentTarget.files?.[0]
      if (file) onChange(file)
      event.currentTarget.value = ''
    }} />
    {url || changed ? <Menu label={label} trigger={trigger} align="start">
      <MenuItem disabled={disabled} onSelect={choose}><ImagePlus size={15} />{uiT(url ? '更换图片' : '上传图片')}</MenuItem>
      {changed && <MenuItem disabled={disabled} onSelect={() => onChange(undefined)}><RotateCcw size={15} />{uiT('撤销图片更改')}</MenuItem>}
      {url && <><MenuSeparator /><MenuItem danger disabled={disabled} onSelect={() => onChange(currentFileId ? null : undefined)}><Trash2 size={15} />{uiT('移除图片')}</MenuItem></>}
    </Menu> : <Button tone="quiet" className="avatar-picker-frame" disabled={disabled} onClick={choose} aria-label={uiT(kind === 'persona' ? '上传人设头像' : '上传角色图片')} title={uiT('支持 PNG、JPEG、WebP，最大 5 MB。')}>{image}</Button>}
  </div>
}
