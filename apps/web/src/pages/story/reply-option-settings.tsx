import { CancelButton, EditorForm } from '../../components/form-guard.tsx'
import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useState } from 'react'
import { api, queryClient, useAction, useSettings, type Settings } from '../../lib/api.ts'
import { Button, ErrorNotice, Loading } from '../../components/ui.tsx'
import { ReplyOptionControls } from '../../components/reply-option-controls.tsx'

export function ReplyOptionSettings({ done }: { done: () => void }) {
  useUiLanguage()
  const query = useSettings()
  return query.data ? <Form initial={query.data} done={done} /> : query.error ? <ErrorNotice source="read" error={query.error} /> : <Loading />
}
function Form({ initial, done }: { initial: Settings; done: () => void }) {
  useUiLanguage()
  const [value, setValue] = useState(initial.preferences), action = useAction()
  return <EditorForm className="stack" dirty={JSON.stringify(value) !== JSON.stringify(initial.preferences)} busy={action.busy} onSubmit={event => { event.preventDefault(); void action.run(async () => { await api('/settings', 'PUT', { expectedRevision: initial.revision, preferences: value }); await queryClient.invalidateQueries({ queryKey: ['settings'] }); done() }) }}><ReplyOptionControls value={value} onChange={next => setValue(current => ({ ...current, ...next }))} /><ErrorNotice error={action.error} /><div className="form-actions sticky-actions"><CancelButton onCancel={done} /><Button type="submit" tone="primary" disabled={action.busy}>{uiT("保存回复选项")}</Button></div></EditorForm>
}
