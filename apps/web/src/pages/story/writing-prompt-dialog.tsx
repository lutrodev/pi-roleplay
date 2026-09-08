import { useState } from 'react'
import type { StoryProfile, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import { EditorForm } from '../../components/form-guard.tsx'
import { Modal } from '../../components/ui.tsx'
import { api, refreshStory, useAction } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { PromptEditor } from './prompt-editor.tsx'

export function WritingPromptDialog({ open, onOpenChange, story, disabled }: {
  open: boolean; onOpenChange: (open: boolean) => void; story: StorySnapshot; disabled: boolean
}) {
  useUiLanguage()
  return <Modal open={open} onOpenChange={onOpenChange} title={uiT('写作 Prompt')}
    description={uiT('构建写作子代理使用的上下文；保存后从下一次回复开始生效。')}
    size="workspace" className="prompt-modal">
    <WritingPromptForm story={story} disabled={disabled} />
  </Modal>
}

function WritingPromptForm({ story, disabled }: { story: StorySnapshot; disabled: boolean }) {
  const [saved, setSaved] = useState(() => ({ profile: structuredClone(story.profile), revision: story.revision }))
  const [contextBuild, setContextBuild] = useState<StoryProfile['contextBuild']>(saved.profile.contextBuild)
  const action = useAction()
  const dirty = JSON.stringify(contextBuild) !== JSON.stringify(saved.profile.contextBuild)
  const profile = { ...saved.profile, contextBuild }
  return <EditorForm className="prompt-form" dirty={dirty} busy={disabled || action.busy} onSubmit={() => {
    if (!dirty || disabled) return
    void action.run(async () => {
      // The captured revision prevents a Prompt save from overwriting concurrent story settings.
      const { story: next } = await api<{ story: StorySnapshot }>(`/stories/${story.id}/profile`, 'PUT', {
        expectedRevision: saved.revision, profile,
      })
      setSaved({ profile: next.profile, revision: next.revision }); setContextBuild(next.profile.contextBuild)
      await refreshStory(story.id)
    })
  }}>
    <PromptEditor storyId={story.id} profile={profile} storyRevision={story.revision} dirty={dirty}
      onChange={setContextBuild} saving={action.busy} disabled={disabled} saveError={action.error} />
  </EditorForm>
}
