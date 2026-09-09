import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ConcurrencySnapshot } from '../../../../../../apps/server/src/services/concurrency-service.ts'
import { api, queryClient, useAction } from '../../../lib/api.ts'
import { uiT } from '../../../lib/i18n.ts'
import { Button, ErrorNotice, Field, Input, Loading } from '../../../components/ui.tsx'
import { SettingsGroup } from '../../../components/settings-layout.tsx'
import { EditorFooter } from '../../../components/editor-footer.tsx'
import { CancelButton, EditorForm } from '../../../components/form-guard.tsx'

export function ConcurrencyEditor({ done }: { done: () => void }) {
  const query = useQuery({ queryKey: ['concurrency'], queryFn: () => api<ConcurrencySnapshot>('/settings/concurrency') })
  return <><ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />
    {query.isPending ? <Loading /> : query.data && <ConcurrencyForm initial={query.data} done={done} />}</>
}
function ConcurrencyForm({ initial, done }: { initial: ConcurrencySnapshot; done: () => void }) {
  const [baseline] = useState(initial), [value, setValue] = useState(initial.settings), action = useAction()
  const dirty = JSON.stringify(value) !== JSON.stringify(baseline.settings)
  return <EditorForm className="stack" dirty={dirty} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => {
    const saved = await api<ConcurrencySnapshot>('/settings/concurrency', 'PUT', { expectedRevision: baseline.revision, settings: value })
    queryClient.setQueryData(['concurrency'], saved)
    await queryClient.invalidateQueries({ queryKey: ['system-status'] }); done()
  }) }}>
    <p className="muted">{uiT('不同会话可以同时生成，同一会话按顺序处理。等待你的回答时不占用请求名额。')}</p>
    <SettingsGroup>
      <Field layout="row" label={uiT('总并发请求')} help={uiT('所有服务连接合计最多同时请求的数量。')}><Input type="number" required min={1} max={32} step={1} value={value.maxRequests} onChange={event => setValue({ ...value, maxRequests: Number(event.target.value) })} /></Field>
      <Field layout="row" label={uiT('每个连接的并发请求')} help={uiT('每个服务连接各自计算，主模型、Writer、子代理和总结合用。')}><Input type="number" required min={1} max={32} step={1} value={value.maxRequestsPerConnection} onChange={event => setValue({ ...value, maxRequestsPerConnection: Number(event.target.value) })} /></Field>
    </SettingsGroup>
    <p className="muted">{uiT('超出名额的请求自动等待。提高上限会立即放行；降低上限会等待已有请求结束，不中断生成。')}</p>
    <EditorFooter error={action.error}><CancelButton onCancel={done} /><Button type="submit" tone="primary" disabled={action.busy || !dirty}>{uiT('保存设置')}</Button></EditorFooter>
  </EditorForm>
}
