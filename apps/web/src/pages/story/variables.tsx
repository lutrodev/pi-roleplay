
import { StoryVariableSettings } from './variable-settings.tsx'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { JsonValue, StorySnapshot, StoryState } from '../../../../../packages/rp-core/src/types.ts'
import { api } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { ErrorNotice, Button, Check, Empty, JsonView } from '../../components/ui.tsx'
import { variableSections, type VariableBoundary, type VariableRow } from './variables-model.ts'

function Value({ value }: { value: JsonValue | undefined }) {
  return <span>{value === undefined ? uiT('不存在') : value === null ? uiT('空') : typeof value === 'boolean' ? uiT(value ? '是' : '否') : typeof value === 'string' ? value || uiT('空文本') : JSON.stringify(value)}</span>
}

export function VariableValues({ state, boundary, compact = false }: { state: StoryState; boundary?: VariableBoundary; compact?: boolean }) {
  useUiLanguage()
  const sections = variableSections(state, boundary)
  return <div className="variable-sections">{sections.map(section => <section className="variable-section" key={section.id}>
    <header><h3>{section.snapshot.definition.title}</h3>{section.removed && <small>{uiT('已移除')}</small>}</header>
    {!compact && section.snapshot.definition.description && <p className="muted">{section.snapshot.definition.description}</p>}
    {section.groups.map(group => <div className="variable-group" key={group.path}>{group.title && <h4>{group.title}</h4>}<dl className="variable-values">{group.rows.map(field => <div className="variable-row" data-changed={field.change ? true : undefined} key={field.path}>
      <dt title={compact ? field.description : field.path} aria-description={compact ? field.description : undefined}>{field.change && <span className="variable-change-mark" role="img" aria-label={uiT('本轮有变化')} />}{field.label}{!compact && field.description && <small>{field.description}</small>}</dt>
      <dd>{compact ? <InlineVariableValue field={field} /> : <><div className="variable-current-value">{field.change?.kind === 'removed' ? <span className="muted">{uiT('已移除')}</span> : <Value value={field.value} />}{field.change?.kind === 'added' && <small>{uiT('新增')}</small>}</div>
        {field.change && field.change.kind !== 'added' && <details className="variable-previous"><summary>{uiT('查看原值')}</summary><div><Value value={field.change.before} /></div></details>}
      </>}</dd>
    </div>)}</dl></div>)}
    {!compact && <details className="variable-definition"><summary>{uiT('变量定义与维护规则')}</summary><JsonView value={section.snapshot.definition} />{(section.snapshot.diagnostics.setup.length > 0 || section.snapshot.diagnostics.lastCommit.length > 0) && <><p>{uiT('初始化与更新提示')}</p><JsonView value={section.snapshot.diagnostics} /></>}</details>}
  </section>)}{!sections.length && <Empty title={uiT('还没有会话变量')}>{uiT('已建立的变量及其变化会显示在这里。')}</Empty>}</div>
}

function InlineVariableValue({ field }: { field: VariableRow }) {
  const [expanded, setExpanded] = useState(false)
  const long = [field.value, field.change?.before].some(value => typeof value === 'string' && (value.length > 160 || value.split('\n').length > 2))
  return <div className="variable-inline-value" data-long={long} data-expanded={expanded}>
    <div className="variable-value-main">
      <span className="variable-after">{field.change && <span className="sr-only">{uiT('当前值：')}</span>}{field.change?.kind === 'removed' ? uiT('已移除') : <Value value={field.value} />}</span>
      {field.change?.kind === 'added' && <small className="variable-value-note">{uiT('新增')}</small>}
    </div>
    {field.change && field.change.kind !== 'added' && <div className="variable-before"><span className="variable-before-label" aria-hidden="true">{uiT('原值')}</span><span className="variable-before-text"><span className="sr-only">{uiT('之前值：')}</span><Value value={field.change.before} /></span></div>}
    {long && <Button tone="quiet" className="variable-value-toggle" aria-expanded={expanded} aria-label={uiT(expanded ? '收起 %{name} 的内容' : '展开 %{name} 的完整内容', { name: field.label })} onClick={() => setExpanded(value => !value)}>{uiT(expanded ? '收起' : '展开')}</Button>}
  </div>
}

export function VariablesPanel({ story, latestReplyId, busy = false }: { story: StorySnapshot; latestReplyId: string | null; busy?: boolean }) {
  useUiLanguage()
  const [markChanges, setMarkChanges] = useState(true)
  const query = useQuery({ queryKey: ['reply-state', story.id, latestReplyId], enabled: !!latestReplyId && markChanges, queryFn: ({ signal }) => api<VariableBoundary>(`/stories/${story.id}/messages/${latestReplyId}/state`, 'GET', undefined, signal) })
  return <div className="variables-panel">
    <StoryVariableSettings story={story} busy={busy} />
    <div className="variables-toolbar">
      <Check checked={markChanges} label={uiT('标记最近一轮变化')} onChange={event => setMarkChanges(event.target.checked)} />
    </div>
    {latestReplyId && markChanges && <ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />}
    <VariableValues state={story.state} boundary={markChanges ? query.data : undefined} />
  </div>
}
