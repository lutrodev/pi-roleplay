import { useEffect, useRef, useState } from 'react'
import type { FileRecord } from '../../../../../packages/rp-core/src/types.ts'
import { api } from '../../lib/api.ts'
import { uiT } from '../../lib/i18n.ts'
import { isPreviewImage, validateAttachments } from './attachment-input.ts'

export interface AttachmentUpload {
  id: string; file: File; previewUrl?: string; status: 'queued' | 'uploading' | 'error'; error?: string
}
type Job = AttachmentUpload & { controller?: AbortController }

/** One queue per composer. Removing an item aborts it and prevents late responses from reattaching it. */
export function useAttachmentUploads(scope: string, files: FileRecord[], onAttach: (file: FileRecord) => void) {
  const jobs = useRef(new Map<string, Job>()), current = useRef({ files, onAttach })
  const uploadIds = useRef(new Map<string, string>())
  current.current = { files, onAttach }
  const [items, setItems] = useState<AttachmentUpload[]>([]), [error, setError] = useState<Error | null>(null)
  const publish = () => setItems([...jobs.current.values()].map(({ controller: _controller, ...job }) => job))
  const release = (job: Job) => { job.controller?.abort(); if (job.previewUrl) URL.revokeObjectURL(job.previewUrl) }
  useEffect(() => {
    setItems([]); setError(null)
    return () => { for (const job of jobs.current.values()) release(job); jobs.current.clear(); uploadIds.current.clear() }
  }, [scope])

  const pump = async () => {
    if ([...jobs.current.values()].some(job => job.status === 'uploading')) return
    const job = [...jobs.current.values()].find(job => job.status === 'queued')
    if (!job) return
    const controller = new AbortController()
    job.status = 'uploading'; job.controller = controller; publish()
    try {
      const body = new FormData(); body.append('file', job.file)
      const result = await api<{ file: FileRecord }>('/files', 'POST', body, controller.signal)
      if (jobs.current.get(job.id) !== job || controller.signal.aborted) return
      // Reserve the completed file synchronously, before React renders the updated draft.
      uploadIds.current.set(result.file.id, job.id)
      current.current.files = [...current.current.files, result.file]
      current.current.onAttach(result.file)
      jobs.current.delete(job.id); release(job)
    } catch (failure) {
      if (jobs.current.get(job.id) !== job || controller.signal.aborted) return
      job.status = 'error'; job.error = failure instanceof Error ? failure.message : uiT('上传失败，请重试。')
      job.controller = undefined
    }
    publish(); void pump()
  }
  const add = (incoming: File[]) => {
    if (!incoming.length) return
    setError(null)
    try { validateAttachments([...current.current.files, ...[...jobs.current.values()].map(job => job.file)], incoming) }
    catch (failure) { setError(failure instanceof Error ? failure : new Error(uiT('上传失败，请重试。'))); return }
    for (const file of incoming) {
      const id = crypto.randomUUID()
      jobs.current.set(id, { id, file, status: 'queued', ...(isPreviewImage(file.type) ? { previewUrl: URL.createObjectURL(file) } : {}) })
    }
    publish(); void pump()
  }
  const remove = (id: string) => {
    const job = jobs.current.get(id)
    if (!job) return
    jobs.current.delete(id); release(job); publish(); void pump()
  }
  const retry = (id: string) => {
    const job = jobs.current.get(id)
    if (!job || job.status !== 'error') return
    job.status = 'queued'; job.error = undefined; publish(); void pump()
  }
  return { items, uploadIds: uploadIds.current, error, add, remove, retry, busy: items.some(item => item.status !== 'error'), blocked: !!items.length }
}
