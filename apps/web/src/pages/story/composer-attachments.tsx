import { ContentImage } from '../../components/content-image.tsx'
import { useLayoutEffect, useRef, useState } from 'react'
import { FileText, LoaderCircle, RotateCw, X } from 'lucide-react'
import type { FileRecord } from '../../../../../packages/rp-core/src/types.ts'
import { Button, IconButton, Modal } from '../../components/ui.tsx'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { attachmentSize, isPreviewImage } from './attachment-input.ts'
import type { AttachmentUpload } from './attachment-uploads.ts'

export function ComposerAttachments({ files, uploads, uploadIds, disabled, remove, cancel, retry }: {
  files: FileRecord[]; uploads: AttachmentUpload[]; disabled: boolean
  uploadIds?: ReadonlyMap<string, string>
  remove: (id: string) => void; cancel: (id: string) => void; retry: (id: string) => void
}) {
  useUiLanguage()
  const [previewId, setPreviewId] = useState<string>()
  const shelf = useRef<HTMLDivElement>(null), previousIds = useRef<string[]>([])
  const entries = [
    ...files.map(file => ({ id: uploadIds?.get(file.id) ?? file.id, fileId: file.id, name: file.name, size: file.size, mimeType: file.mimeType, url: `/api/files/${file.id}/content`, upload: undefined as AttachmentUpload | undefined })),
    ...uploads.map(upload => ({ id: upload.id, fileId: undefined, name: upload.file.name, size: upload.file.size, mimeType: upload.file.type, url: upload.previewUrl, upload })),
  ]
  const lastId = entries.at(-1)?.id
  useLayoutEffect(() => {
    if (lastId && !previousIds.current.includes(lastId)) shelf.current?.scrollTo({ left: shelf.current.scrollWidth })
    previousIds.current = entries.map(entry => entry.id)
  }, [lastId])
  const preview = entries.find(entry => entry.id === previewId)
  if (!entries.length) return null
  return <>
    <div ref={shelf} className="composer-attachments" role="list" aria-label={uiT('待发送附件')}>
      {entries.map(entry => {
        const image = isPreviewImage(entry.mimeType), failed = entry.upload?.status === 'error', busy = !!entry.upload && !failed
        return <div className={`composer-attachment ${image ? 'attachment-image' : 'attachment-file'}${failed ? ' attachment-failed' : ''}`} key={entry.id} role="listitem" title={entry.name}>
          {image ? <button type="button" className="attachment-thumbnail" aria-label={uiT('预览图片 %{name}', { name: entry.name })} onClick={() => setPreviewId(entry.id)}>
            <ContentImage src={entry.url} alt={entry.name} />
          </button> : <div className="attachment-file-content"><FileText size={24} aria-hidden="true" /><span><strong>{entry.name}</strong><small>{entry.name.split('.').length > 1 ? entry.name.split('.').at(-1)!.slice(0, 12).toUpperCase() : uiT('文件')} · {attachmentSize(entry.size)}</small></span></div>}
          <IconButton className="attachment-remove" disabled={disabled} label={uiT('移除附件 %{v0}', { v0: entry.name })} onClick={() => entry.upload ? cancel(entry.id) : remove(entry.fileId!)}><X size={14} /></IconButton>
          {busy && <span className="attachment-status" role="status"><LoaderCircle size={13} className="spinner" />{entry.upload!.status === 'queued' ? uiT('等待上传') : uiT('上传中')}</span>}
          {failed && <Button tone="quiet" className="attachment-retry" title={entry.upload!.error} aria-label={uiT('重试上传 %{name}：%{error}', { name: entry.name, error: entry.upload!.error ?? '' })} onClick={() => retry(entry.id)}><RotateCw size={13} />{uiT('上传失败 · 重试')}</Button>}
        </div>
      })}
    </div>
    {uploads.filter(upload => upload.status === 'error').map(upload => <p key={upload.id} className="attachment-upload-error" role="alert">{upload.file.name}：{uiT(upload.error ?? '上传失败，请重试。')}</p>)}
    <Modal open={!!preview} onOpenChange={open => { if (!open) setPreviewId(undefined) }} title={preview?.name ?? uiT('图片预览')} description={preview && attachmentSize(preview.size)} size="editor" className="attachment-preview">
      {preview && <ContentImage src={preview.url} alt={preview.name} />}
    </Modal>
  </>
}
