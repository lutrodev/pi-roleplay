import { Check, CircleAlert, Copy, LoaderCircle, X } from 'lucide-react'
import type { AssetKind } from '../../../../../packages/rp-core/src/types.ts'
import { Button, ErrorNotice, IconButton } from '../../components/ui.tsx'
import { ProgressBar } from '../../components/progress-bar.tsx'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'

export interface ImportOutcome { name: string; status: 'success' | 'duplicate' | 'failed'; message: string; id?: string }
export interface ImportBatch { kind: AssetKind; total: number; current: string; outcomes: ImportOutcome[] }

export function importSummary(batch: ImportBatch) {
  return { completed: batch.outcomes.length, success: batch.outcomes.filter(item => item.status === 'success').length, duplicate: batch.outcomes.filter(item => item.status === 'duplicate').length, failed: batch.outcomes.filter(item => item.status === 'failed').length }
}

export function ImportFeedback({ batch, busy, hide, open, refreshError, retry, retrying }: {
  batch: ImportBatch; busy: boolean; hide: (restoreFocus?: boolean) => void; open: (id: string, kind: AssetKind) => void
  refreshError: Error | null; retry: () => void; retrying: boolean
}) {
  useUiLanguage()
  const counts = importSummary(batch)
  const title = busy ? uiT('正在导入资料') : counts.failed ? uiT(counts.success || counts.duplicate ? '部分资料未能导入' : '资料未能导入') : uiT('导入完成')
  const Icon = busy ? LoaderCircle : counts.failed ? CircleAlert : Check
  return <>
    <header className="import-results-heading"><Icon size={16} className={busy ? 'spinner' : ''} aria-hidden="true" /><h3>{title}</h3><span>{counts.completed} / {batch.total}</span><IconButton label={uiT(busy ? '隐藏导入进度' : '隐藏导入结果')} onClick={() => hide(true)}><X size={16} /></IconButton></header>
    <ProgressBar className="import-progress" label={uiT('资料导入')} maximum={batch.total} value={counts.completed} />
    <p className="import-results-summary" role="status">{busy ? uiT('正在导入：%{v0}', { v0: batch.current }) : uiT('成功 %{v0}，重复 %{v1}，失败 %{v2}', { v0: counts.success, v1: counts.duplicate, v2: counts.failed })}</p>
    <div className="import-results-body">
      <ul>{batch.outcomes.map((item, index) => {
        const ItemIcon = item.status === 'failed' ? CircleAlert : item.status === 'duplicate' ? Copy : Check
        return <li key={index} data-status={item.status}><ItemIcon size={14} aria-hidden="true" /><div><strong>{item.name}</strong><p>{item.message}</p></div>{item.id && <Button tone="quiet" onClick={() => { open(item.id!, batch.kind); hide() }}>{uiT('打开资料')}</Button>}</li>
      })}</ul>
      <ErrorNotice error={refreshError} title={uiT('导入结果已保留，列表刷新失败')} retry={retry} retrying={retrying} />
    </div>
  </>
}
