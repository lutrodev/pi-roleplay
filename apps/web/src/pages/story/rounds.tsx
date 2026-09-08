
import { uiT, uiLocale, useUiLanguage } from '../../lib/i18n.ts'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { api } from '../../lib/api.ts'
import { ErrorNotice, Button, Empty, Input, Loading } from '../../components/ui.tsx'

interface Round { index: number; messageId: string; runId: string | null; createdAt: string; preview: string; opening: boolean }
export function ConversationHistory({ storyId, busy, onJump }: { storyId: string; busy: boolean; onJump: (id: string) => void }) {
  useUiLanguage()
  const [query, setQuery] = useState(''), [visible, setVisible] = useState(50)
  const history = useQuery({ queryKey: ['rounds', storyId], queryFn: ({ signal }) => api<{ rounds: Round[] }>(`/stories/${storyId}/rounds`, 'GET', undefined, signal) })
  const rounds = history.data?.rounds ?? [], filtered = rounds.filter(round => `${round.index} ${round.preview}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <div className="stack"><Input aria-label={uiT('搜索输入内容')} value={query} onChange={event => { setQuery(event.target.value); setVisible(50) }} placeholder={uiT('查找你说过的话…')} maxLength={300} />
    <div className="trace-actions"><Button disabled={busy || !rounds.length} onClick={() => onJump(rounds[0]!.messageId)}><ArrowUp size={15} />{uiT('最早一轮')}</Button><Button disabled={busy || !rounds.length} onClick={() => onJump(rounds.at(-1)!.messageId)}><ArrowDown size={15} />{uiT('最新一轮')}</Button></div><ErrorNotice error={history.error} retry={() => void history.refetch()} retrying={history.isFetching} />{history.isPending && <Loading />}
    <div className="conversation-history">{filtered.slice(0, visible).map(round => <button key={round.messageId} disabled={busy} onClick={() => onJump(round.messageId)}><small>{round.opening ? uiT('开场') : uiT('第 %{v0} 轮', { v0: round.index })} · {new Date(round.createdAt).toLocaleString(uiLocale())}</small><span>{round.preview || uiT('附件消息')}</span></button>)}</div>
    {filtered.length > visible && <Button onClick={() => setVisible(value => value + 50)}>{uiT('显示更多轮次')}</Button>}{history.data && !filtered.length && <Empty title={uiT('没有匹配的轮次')} />}
  </div>
}
