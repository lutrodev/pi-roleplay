import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { StoryProfile } from '../../../../../../packages/rp-core/src/types.ts'
import { promptDocument, type PromptBuild, type PromptInspection } from '../../../../../../packages/rp-core/src/context/preview.ts'
import { Button, Empty, ErrorNotice, JsonView, Loading } from '../../../components/ui.tsx'
import { SettingToggle } from '../../../components/settings-controls.tsx'
import { api } from '../../../lib/api.ts'
import { uiT, useUiLanguage } from '../../../lib/i18n.ts'
import { formatPromptCount, PromptIcon, slotTone } from './cards.tsx'

export function PromptPreviewPane({ storyId, profile, build, document, blocked, mobile, mode, onModeChange, onChange }: {
  storyId: string; profile: StoryProfile; build: PromptBuild; document: ReturnType<typeof promptDocument>
  blocked: boolean; mobile: boolean; mode: 'cards' | 'plain'; onModeChange: (mode: 'cards' | 'plain') => void
  onChange: (build: PromptBuild) => void
}) {
  useUiLanguage()
  const [advanced, setAdvanced] = useState(false), [serverPreview, setServerPreview] = useState<PromptInspection | null>(null), [serverError, setServerError] = useState<Error | null>(null)
  const invalidName = build.slots.some(slot => slot.id.startsWith('custom-') && !slot.label.trim())
  const serverProfile = JSON.stringify({ ...profile, contextBuild: build })
  useEffect(() => {
    if (!advanced || invalidName || blocked) return
    const controller = new AbortController()
    setServerPreview(null); setServerError(null)
    const timer = setTimeout(() => { void api<PromptInspection>(`/stories/${storyId}/context-preview`, 'POST', { profile: JSON.parse(serverProfile) }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setServerPreview(value) }).catch(error => { if (!controller.signal.aborted) setServerError(error) }) }, 180)
    return () => { clearTimeout(timer); controller.abort() }
  }, [advanced, invalidName, serverProfile, storyId, blocked])
  return <aside className="prompt-preview-pane">
    <header><div><small>{uiT('回复预览')}</small><h3>{uiT('写作子代理预览')}</h3></div><div className="prompt-mode" role="group" aria-label={uiT('预览方式')}>
      {(['cards', 'plain'] as const).map(value => <Button key={value} aria-pressed={mode === value} onClick={() => onModeChange(value)}>{value === 'cards' ? uiT('资料卡片') : uiT('纯文本')}</Button>)}
    </div></header>
    <p className="prompt-help">{mode === 'cards' ? uiT('展开分组查看发送文本，并设置是否保留分组标签。') : uiT('按当前顺序拼接；调整顺序、内容和标签会立即更新。')} {uiT(' 当前输入将在生成时填入。')}</p>
    <div className="prompt-document" data-prompt-scroll={!mobile || undefined}>
      {mode === 'plain' ? <pre aria-label={uiT('下次回复的纯文本预览')} className="prompt-plain">{document.text}</pre> : document.groups.map(group => <details className="prompt-preview-group" data-tone={slotTone(group)} key={group.id}>
        <summary><PromptIcon tone={slotTone(group)} /><strong>{group.label}</strong><span>{group.sourceIds.length} {uiT(' 份 · ')}{formatPromptCount(group.characters)} {uiT(' 字')}</span><Plus size={15} className="prompt-expand" /></summary>
        <div className="prompt-preview-body"><SettingToggle label={uiT('分组标签')} help={group.sectionTag !== false ? uiT('使用 <section>；多份资料使用 <item>。') : uiT('直接拼接这个分组内的资料原文。')} aria-label={uiT('为%{v0}保留分组标签', { v0: group.label })} checked={group.sectionTag !== false} disabled={blocked}
          onChange={event => onChange({ ...build, slots: build.slots.map(slot => slot.id === group.id ? { ...slot, sectionTag: event.target.checked } : slot) })} /><pre aria-label={uiT('%{v0}实际发送内容', { v0: group.label })}>{group.text}</pre></div>
      </details>)}
      {!document.groups.length && <Empty title={uiT('还没有可预览的资料')}>{uiT('选择角色卡或添加自定义资料后，会在这里显示。')}</Empty>}
      <details className="prompt-advanced" onToggle={event => setAdvanced(event.currentTarget.open)}><summary>{uiT('父模型资料与激活诊断')}</summary>
        <p className="prompt-help">{uiT('实际模型请求还包含运行时规则；历史执行中的完整请求可在运行记录查看。')}</p>
        {advanced && <>{serverError ? <ErrorNotice error={serverError} /> : !serverPreview ? <Loading label={uiT('正在校验当前资料…')} /> : <><pre className="prompt-plain" aria-label={uiT('父模型 RP 资料')}>{serverPreview.parentPrompt}</pre><details><summary>{uiT('资料缺失与世界书激活详情')}</summary><JsonView value={serverPreview.diagnostics} /></details></>}</>}
      </details>
    </div>
  </aside>
}
