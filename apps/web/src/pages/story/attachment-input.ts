import { uiT } from '../../lib/i18n.ts'

export const attachmentLimits = { count: 16, fileBytes: 25 * 1024 * 1024, totalBytes: 50 * 1024 * 1024 }
export const isPreviewImage = (mimeType: string) => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)

/** Clipboard implementations expose files through either surface. Do not read both and duplicate images. */
export function transferFiles(transfer: Pick<DataTransfer, 'files' | 'items'>): File[] {
  if (transfer.files.length) return Array.from(transfer.files)
  return Array.from(transfer.items).flatMap(item => {
    const file = item.kind === 'file' ? item.getAsFile() : null
    return file ? [file] : []
  })
}

export function validateAttachments(existing: readonly { size: number }[], incoming: readonly { name: string; size: number }[]) {
  if (existing.length + incoming.length > attachmentLimits.count) throw new Error(uiT('每轮最多添加 16 个附件。'))
  for (const file of incoming) {
    if (!file.size) throw new Error(uiT('文件 %{name} 为空，请选择有内容的文件。', { name: file.name }))
    if (file.size > attachmentLimits.fileBytes) throw new Error(uiT('文件 %{name} 超过 25 MB，请选择较小的文件。', { name: file.name }))
  }
  if ([...existing, ...incoming].reduce((sum, file) => sum + file.size, 0) > attachmentLimits.totalBytes) throw new Error(uiT('每轮附件总量不能超过 50 MB。'))
}

export function attachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, '')} MB`
}

/** A mixed image + text paste should replace the selection, just like an ordinary text paste. */
export function pasteAttachmentText(text: string, pasted: string, start: number, end: number) {
  const insertion = [...pasted].slice(0, Math.max(0, 200000 - [...text.slice(0, start) + text.slice(end)].length)).join('')
  return { text: text.slice(0, start) + insertion + text.slice(end), cursor: start + insertion.length }
}
