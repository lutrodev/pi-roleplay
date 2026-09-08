import { ProgressBar } from '../../components/progress-bar.tsx'
import { uiT, uiLocale, useUiLanguage } from "../../lib/i18n.ts"
import { useQuery } from '@tanstack/react-query'
import type { ContextUsage } from '../../../../../packages/protocol/src/context-usage.ts'
import { api } from '../../lib/api.ts'
import { Empty, ErrorNotice, Loading, Modal } from '../../components/ui.tsx'

export function ContextUsageDialog({ storyId, open, onOpenChange }: { storyId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  useUiLanguage()
  const query = useQuery({ queryKey: ['context-usage', storyId], enabled: open, queryFn: () => api<{ usage: ContextUsage[] }>(`/stories/${storyId}/context-usage`) })
  return <Modal size="form" open={open} onOpenChange={onOpenChange} title={uiT("上下文占用")}><p className="muted">{uiT("显示主模型和 Writer 最近一次请求的实际用量，包含缓存输入和输出。正在输入的草稿、尚未完成的请求不计入；这不是会话累计花费。")}</p><ErrorNotice error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />{query.isPending && <Loading />}{query.data?.usage.map(item => <section className="stack" key={item.scope}><h3>{item.scope === 'main' ? uiT("主模型") : 'Writer'}</h3><p className="muted">{item.model} · {new Date(item.at).toLocaleString(uiLocale())}</p>{item.used === null ? <p>{uiT("此次请求尚无可用的用量数据。")}</p> : <><ProgressBar className="context-progress" maximum={item.contextWindow} value={item.used} label={uiT("%{v0} 上下文占用", { v0: item.scope === 'main' ? uiT("主模型") : 'Writer' })} /><p>{item.used.toLocaleString()} / {item.contextWindow.toLocaleString()} {uiT(" tokens · 输入 ")}{item.input?.toLocaleString()} {uiT(" · 输出 ")}{item.output?.toLocaleString()}</p></>}</section>)}{!query.error && query.data?.usage.length === 0 && <Empty title={uiT("还没有模型请求")} />}</Modal>
}
