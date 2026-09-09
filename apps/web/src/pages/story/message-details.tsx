import { uiT, uiLocale, useUiLanguage } from "../../lib/i18n.ts"
import { useQuery } from '@tanstack/react-query'
import type { RunTrace } from '../../../../../packages/protocol/src/trace.ts'
import type { StoryMessage } from '../../../../../packages/rp-core/src/types.ts'
import { api } from '../../lib/api.ts'
import { ErrorNotice, Loading } from '../../components/ui.tsx'

export function MessageDetails({ message }: { message: StoryMessage }) {
  useUiLanguage()
  const query = useQuery({ queryKey: ['run-trace', message.runId, ''], enabled: !!message.runId, queryFn: ({ signal }) => api<RunTrace>(`/runs/${message.runId}/trace`, 'GET', undefined, signal) })
  const data = query.data, requests = data?.requests ?? [], measured = requests.filter(request => request.usage)
  const total = measured.reduce((sum, request) => ({ input: sum.input + request.usage!.input, output: sum.output + request.usage!.output, cacheRead: sum.cacheRead + request.usage!.cacheRead, cacheWrite: sum.cacheWrite + request.usage!.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  return <div className="stack"><p>{uiT("消息时间：")}{new Date(message.createdAt).toLocaleString(uiLocale())}</p><p>{[...message.text].length.toLocaleString(uiLocale())} {uiT(" 字 · ")}{message.attachmentIds.length} {uiT(" 个附件")}</p>
    {message.runId ? <><h3>{uiT("所属轮次统计")}</h3><p className="muted">{uiT("包含这轮主模型、Writer 与任务子代理的调用。")}</p><ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />{query.isPending && <Loading />}{data && <><p>{data.requests.length} {uiT(" 次模型请求 · ")}{data.tools.length} {uiT(" 次工具调用 · ")}{((Date.parse(data.run.updatedAt) - Date.parse(data.run.createdAt)) / 1000).toFixed(2)} {uiT(" 秒")}{['running', 'waiting_user', 'queued'].includes(data.run.status) && uiT("（仍在运行）")}</p>
      {measured.length ? <dl className="status-list"><div><dt>{uiT("输入 tokens")}</dt><dd>{total.input.toLocaleString(uiLocale())}</dd></div><div><dt>{uiT("输出 tokens")}</dt><dd>{total.output.toLocaleString(uiLocale())}</dd></div><div><dt>{uiT("缓存读取 / 写入")}</dt><dd>{total.cacheRead.toLocaleString(uiLocale())} / {total.cacheWrite.toLocaleString(uiLocale())}</dd></div></dl> : <p className="muted">{uiT("这轮尚无可用的用量记录。")}</p>}
      {measured.length > 0 && measured.length < requests.length && <p className="muted">{requests.length - measured.length} {uiT(" 次请求未返回用量，未计入以上合计。")}</p>}
      {[...new Set(requests.map(request => `${request.provider} / ${request.model}`))].map(model => <small key={model}>{model}</small>)}
    </>}</> : <p className="muted">{uiT("此消息没有模型生成轮次。")}</p>}
  </div>
}
