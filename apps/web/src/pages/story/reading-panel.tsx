import { EditorFooter } from '../../components/editor-footer.tsx'
import { useState } from 'react'
import { api, queryClient, useAction, useSettings } from '../../lib/api.ts'
import { EditorForm } from '../../components/form-guard.tsx'
import { Button, ErrorNotice, Loading } from '../../components/ui.tsx'
import { ReadingControls } from '../../components/reading-controls.tsx'
import { uiT } from '../../lib/i18n.ts'
import { mergeSection, sectionChanged } from '../settings/preference-drafts.ts'

export function ReadingPanel() {
  const settings = useSettings()
  if (!settings.data) return settings.error ? <ErrorNotice source="read" error={settings.error} /> : <Loading />
  return <ReadingForm initial={settings.data} />
}
function ReadingForm({ initial }: { initial: NonNullable<ReturnType<typeof useSettings>['data']> }) {
  const [saved, setSaved] = useState(initial), [value, setValue] = useState(initial.preferences), action = useAction()
  const dirty = sectionChanged(saved.preferences, value, 'reading')
  return <EditorForm className="reading-panel stack" dirty={dirty} busy={action.busy} onSubmit={() => void action.run(async () => {
    const updated = await api<typeof initial>('/settings', 'PUT', { expectedRevision: saved.revision, preferences: mergeSection(saved.preferences, value, 'reading') })
    const next = { ...saved, ...updated }
    setSaved(next); setValue(next.preferences); queryClient.setQueryData(['settings'], next)
  })}>
    <ReadingControls value={value.reading} onChange={next => setValue(current => ({ ...current, reading: { ...current.reading, ...next } }))} />
    <EditorFooter error={action.error}><Button disabled={action.busy || !dirty} onClick={() => setValue(saved.preferences)}>{uiT('还原修改')}</Button><Button type="submit" tone="primary" disabled={action.busy || !dirty}>{action.busy ? uiT('正在保存…') : uiT('保存')}</Button></EditorFooter>
  </EditorForm>
}
