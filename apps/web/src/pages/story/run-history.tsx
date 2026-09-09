
import { uiT, uiLocale, useUiLanguage } from "../../lib/i18n.ts"
import { useState } from 'react'
import type { RunRecord } from '../../../../../packages/rp-core/src/types.ts'
import { api, useAction } from '../../lib/api.ts'
import { ErrorNotice, Button, Field, Select } from '../../components/ui.tsx'

export const runStatus: Record<RunRecord['status'], string> = { queued: '排队中', running: '生成中', waiting_user: '等待回答', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '被重启中断' }
export function useRunHistory(storyId: string, recent: RunRecord[]) {
  const [older, setOlder] = useState<RunRecord[]>([]), [exhausted, setExhausted] = useState(false), action = useAction()
  const runs = [...new Map([...recent, ...older].map(run => [run.id, run])).values()]
  const load = () => action.run(async () => {
    const result = await api<{ runs: RunRecord[]; nextCursor: string | null }>(`/stories/${storyId}/runs?before=${runs.at(-1)!.id}`)
    setOlder(current => [...current, ...result.runs]); setExhausted(result.nextCursor === null)
  })
  return { runs, load, canLoad: recent.length >= 30 && !exhausted, ...action }
}
export function RunSelector({ history, selected, onChange }: { history: ReturnType<typeof useRunHistory>; selected: string; onChange: (id: string) => void }) {
  useUiLanguage()
  return <><Field label={uiT("执行记录")}><Select value={selected} onChange={event => onChange(event.target.value)}>{history.runs.map(run => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString(uiLocale())} · {uiT(runStatus[run.status])}</option>)}</Select></Field>{history.canLoad && <Button disabled={history.busy} onClick={() => void history.load()}>{uiT("加载更早的执行记录")}</Button>}<ErrorNotice source="read" error={history.error} /></>
}
