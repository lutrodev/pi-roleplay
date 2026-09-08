import type { RunRecord, StoryMessage } from '../../../../../packages/rp-core/src/types.ts'
import { ChevronRight } from 'lucide-react'
import { Button } from '../../components/ui.tsx'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'

/** Status changes never move a round's entry away from its final visible reply. */
export function roundTraceEntries(messages: readonly StoryMessage[], latest?: Pick<RunRecord, 'id'>) {
  const replies = new Map<string, string>()
  for (const message of messages) {
    if (!message.runId || message.role !== 'assistant' || message.kind === 'tool' || message.kind === 'opening') continue
    replies.set(message.runId, message.id)
  }
  return { messages: new Map([...replies].map(([runId, messageId]) => [messageId, runId])), pending: latest && !replies.has(latest.id) ? latest.id : null }
}

export function RoundTraceLink({ runId, inspect }: { runId: string; inspect: () => void }) {
  useUiLanguage()
  return <Button tone="quiet" className="reply-detail-link" data-trace-run-id={runId} onClick={inspect}>{uiT('查看本轮轨迹')}<ChevronRight size={13} /></Button>
}
