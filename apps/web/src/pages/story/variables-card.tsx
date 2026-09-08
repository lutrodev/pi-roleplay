import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronDown } from 'lucide-react'
import type { StoryState } from '../../../../../packages/rp-core/src/types.ts'
import { api } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { Button, ErrorNotice } from '../../components/ui.tsx'
import { variableSections, type VariableBoundary } from './variables-model.ts'
import { VariableValues } from './variables.tsx'

export function VariablesToggle({ expanded, bodyId, onToggle }: { expanded: boolean; bodyId: string; onToggle: () => void }) {
  useUiLanguage()
  return <Button tone="quiet" className="reply-detail-link reply-variables-toggle" aria-label={uiT(expanded ? '折叠会话变量' : '展开会话变量')} aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
    {uiT('会话变量')}<ChevronDown size={13} className="variable-card-chevron" aria-hidden="true" />
  </Button>
}

/** Controlled by the latest reply's footer; values always come from live story state. */
export function VariablesCard({ storyId, replyId, state, expanded, bodyId, onInteract }: { storyId: string; replyId: string; state: StoryState; expanded: boolean; bodyId: string; onInteract?: () => void }) {
  useUiLanguage()
  const reduced = useReducedMotion()
  const groups = Object.keys(state.namespaces).length
  const query = useQuery({ queryKey: ['reply-state', storyId, replyId], enabled: groups > 0, queryFn: ({ signal }) => api<VariableBoundary>(`/stories/${storyId}/messages/${replyId}/state`, 'GET', undefined, signal) })
  if (groups === 0) return null
  const fields = variableSections(state, query.data).flatMap(section => section.groups.flatMap(group => group.rows))
  const count = fields.filter(field => field.change?.kind !== 'removed').length, changes = fields.filter(field => field.change).length
  const transition = { duration: reduced ? 0 : 0.16 }
  return <AnimatePresence initial={false}>{expanded && <motion.section key="values" id={bodyId} className="variable-card-motion" aria-label={uiT('当前会话变量')} onClickCapture={onInteract} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={transition}>
    <div className="variable-card">
      <header className="variable-card-heading"><span className="variable-card-title"><strong>{uiT('会话变量')}</strong><small>{uiT('%{groups} 组 · %{count} 项', { groups, count })}</small></span>{changes > 0 && <span className="variable-card-changes">{uiT('本轮更新 %{count}', { count: changes })}</span>}</header>
      <div className="variable-card-body"><ErrorNotice error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} /><VariableValues state={state} boundary={query.data} compact /></div>
    </div>
  </motion.section>}</AnimatePresence>
}
