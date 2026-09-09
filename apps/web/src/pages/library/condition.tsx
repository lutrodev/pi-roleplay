import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { JsonObject, JsonValue, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import { stateFields } from '../../../../../packages/rp-core/src/display/state-fields.ts'
import { compileStateCondition } from '../../../../../packages/rp-core/src/state/condition.js'
import { api } from '../../lib/api.ts'
import { Button, ErrorNotice, Field, Input, Select, Textarea } from '../../components/ui.tsx'

export function ConditionEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  useUiLanguage()
  const [storyId, setStory] = useState(''), [namespace, setNamespace] = useState(''), [path, setPath] = useState(''), [operator, setOperator] = useState('=='), [comparison, setComparison] = useState(''), [error, setError] = useState<Error | null>(null)
  const catalog = useQuery({ queryKey: ['stories', 'condition-picker'], queryFn: () => api<{ stories: { id: string; title: string }[] }>('/stories') })
  const source = useQuery({ queryKey: ['condition-state', storyId], enabled: !!storyId, queryFn: () => api<{ story: StorySnapshot }>(`/stories/${storyId}`) })
  const state = source.data?.story.state, fields = state?.namespaces[namespace] ? stateFields(state.namespaces[namespace].value as JsonValue, state.namespaces[namespace].definition.schema as unknown as JsonObject).filter(field => field.value === null || typeof field.value !== 'object') : []
  const current = fields.find(field => field.path === path)
  return <section className="stack condition-editor"><h4>{uiT("变量条件（可选）")}</h4><p className="muted">{uiT("从已有会话的变量中选择。这里只编辑触发条件；共享世界书会在使用它的会话中判断条件。")}</p>
    <Field label={uiT("参考会话")}><Select value={storyId} onChange={event => { setStory(event.target.value); setNamespace(''); setPath('') }}><option value="">{uiT("选择已有会话")}</option>{catalog.data?.stories.map(story => <option key={story.id} value={story.id}>{story.title}</option>)}</Select></Field>
    {storyId && <><Field label={uiT("变量命名空间")}><Select value={namespace} onChange={event => { setNamespace(event.target.value); setPath('') }}><option value="">{uiT("请选择")}</option>{Object.entries(state?.namespaces ?? {}).map(([id, item]) => <option value={id} key={id}>{item.definition.title} · {id}</option>)}</Select></Field><Field label={uiT("变量字段")}><Select value={path} onChange={event => setPath(event.target.value)}><option value="" disabled={fields.every(field => field.path !== '')}>{uiT("请选择")}</option>{fields.map(field => <option key={field.path} value={field.path}>{field.title} · {field.path || '/'}</option>)}</Select></Field><div className="form-grid"><Field label={uiT("判断方式")}><Select value={operator} onChange={event => setOperator(event.target.value)}>{['==', '!=', '>', '>=', '<', '<=', 'exists', 'missing'].map(op => <option key={op} value={op}>{{ exists: uiT("存在"), missing: uiT("不存在") }[op] ?? op}</option>)}</Select></Field>{!['exists', 'missing'].includes(operator) && <Field label={uiT("比较值")} help={typeof current?.value === 'string' ? uiT("按文字比较") : uiT("数字、true、false 或 null")}><Input value={comparison} onChange={event => setComparison(event.target.value)} /></Field>}</div><Button disabled={!namespace || !current} onClick={() => {
      try {
        const call = `exists(${JSON.stringify(namespace)}, ${JSON.stringify(path)})`
        const literal = ['exists', 'missing'].includes(operator) ? '' : typeof current?.value === 'string' ? JSON.stringify(comparison) : JSON.stringify(JSON.parse(comparison))
        const expression = operator === 'exists' ? call : operator === 'missing' ? `!${call}` : `state(${JSON.stringify(namespace)}, ${JSON.stringify(path)}) ${operator} ${literal}`
        compileStateCondition(expression); onChange(expression); setError(null)
      } catch { setError(new Error(uiT("比较值格式不正确，请填写与变量相同类型的值。"))) }
    }}>{uiT("应用这个条件")}</Button>{state && !Object.keys(state.namespaces).length && <p className="muted">{uiT("当前会话还没有变量。")}</p>}</>}
    <Field label={uiT("当前条件")}><Input readOnly value={value} placeholder={uiT("没有条件，按关键词和常驻设置激活")} /></Field>
    <details><summary>{uiT("高级条件表达式")}</summary><Field label={uiT("条件表达式")}><Textarea rows={3} value={value} onChange={event => onChange(event.target.value)} /></Field><p className="muted">{uiT("支持 state、exists、比较、逻辑运算；缺失变量不会激活条目。")}</p></details>{value && <Button onClick={() => onChange('')}>{uiT("清除条件")}</Button>}<ErrorNotice source={error ? 'action' : 'read'} error={error ?? source.error ?? catalog.error} />
  </section>
}
