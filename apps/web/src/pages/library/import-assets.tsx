import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useEffect, useRef, useState } from 'react'
import { Upload, LoaderCircle } from 'lucide-react'
import type { AssetKind, AssetRecord } from '../../../../../packages/rp-core/src/types.ts'
import { api, ApiError } from '../../lib/api.ts'
import { Button } from '../../components/ui.tsx'

import { ImportFeedback, type ImportBatch, type ImportOutcome } from './import-feedback.tsx'
export function ImportAssets({ kind, refresh, open, onBusy }: { kind: AssetKind; refresh: () => Promise<void>; open: (id: string, kind: AssetKind) => void; onBusy: (busy: boolean) => void }) {
  useUiLanguage()
  const input = useRef<HTMLInputElement>(null), lock = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null), resultsTrigger = useRef<HTMLButtonElement>(null)
  const [batch, setBatch] = useState<ImportBatch | null>(null), [busy, setBusy] = useState(false)
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false)
  const [visible, setVisible] = useState(false), [refreshError, setRefreshError] = useState<Error | null>(null), [retrying, setRetrying] = useState(false)
  const dismiss = (restoreFocus = false) => {
    setVisible(false); setHovered(false); setFocused(false)
    if (restoreFocus) requestAnimationFrame(() => (resultsTrigger.current ?? trigger.current)?.focus({ preventScroll: true }))
  }
  const refreshList = async () => { setRetrying(true); setRefreshError(null); try { await refresh() } catch (error) { setRefreshError(error instanceof Error ? error : new Error(uiT('列表刷新失败，请重试。'))) } finally { setRetrying(false) } }
  useEffect(() => {
    if (!visible || !batch || refreshError || busy || hovered || focused || batch.outcomes.length !== batch.total || batch.outcomes.some(item => item.status !== 'success')) return
    // Keep actionable results until dismissed, and let readers finish before hiding successes.
    const timer = setTimeout(() => setVisible(false), 5000)
    return () => clearTimeout(timer)
  }, [batch, busy, hovered, focused, visible, refreshError])
  return <><Button ref={trigger} onClick={() => busy ? setVisible(true) : input.current?.click()}>{busy ? <LoaderCircle size={16} className="spinner" /> : <Upload size={16} />}{uiT(busy ? "查看导入进度" : "批量导入")}</Button>{batch && !busy && !visible && <Button ref={resultsTrigger} tone="quiet" onClick={() => setVisible(true)}>{uiT("查看导入结果")}</Button>}<input ref={input} type="file" hidden multiple accept={kind === 'character' ? '.json,.png' : '.json'} onChange={event => {
    const files = Array.from(event.target.files ?? []); event.target.value = ''; if (lock.current || !files.length) return
    lock.current = true; setVisible(true); setRefreshError(null); setBusy(true); onBusy(true); setHovered(false); setFocused(false); const targetKind = kind
    setBatch({ kind: targetKind, total: files.length, current: files[0]!.name, outcomes: [] })
    void (async () => {
      try {
        for (const file of files) {
          setBatch(value => value && ({ ...value, current: file.name }))
          let outcome: ImportOutcome
          try {
            const maximum = targetKind === 'character' ? 20 : targetKind === 'lorebook' ? 2 : 10
            if (file.size > maximum * 1024 * 1024) throw new Error(uiT("文件超过 %{v0} MB 上限。", { v0: maximum }))
            let asset: AssetRecord
            if (targetKind === 'character' || targetKind === 'lorebook') {
              const body = new FormData(); body.append('file', file)
              const result = await api<{ card?: AssetRecord; asset?: AssetRecord }>(`/assets/import/${targetKind}`, 'POST', body); asset = (result.card ?? result.asset)!
            } else { const data = JSON.parse(await file.text()); asset = (await api<{ asset: AssetRecord }>('/assets', 'POST', { kind: targetKind, data: data.data ?? data })).asset }
            outcome = { name: file.name, status: 'success', message: uiT("导入成功"), id: asset.id }
          } catch (error) {
            const duplicate = error instanceof ApiError && error.code === 'DUPLICATE_ASSET', details = error instanceof ApiError ? error.details as { assetId?: string } | undefined : undefined
            outcome = { name: file.name, status: duplicate ? 'duplicate' : 'failed', message: error instanceof Error ? error.message : uiT("导入失败"), ...(duplicate && details?.assetId ? { id: details.assetId } : {}) }
          }
          setBatch(value => value && ({ ...value, outcomes: [...value.outcomes, outcome] }))
        }
        await refreshList()
      } finally { lock.current = false; setBusy(false); onBusy(false); setBatch(value => value && ({ ...value, current: '' })) }
    })()
  }} />{batch && visible && <section className="import-results" aria-label={uiT("资料导入")}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
    <ImportFeedback batch={batch} busy={busy} hide={dismiss} open={open} refreshError={refreshError} retry={() => void refreshList()} retrying={retrying} />
  </section>}</>
}
