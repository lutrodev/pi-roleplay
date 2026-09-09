
import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { ToggleGroup } from 'radix-ui'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import type { StoryProfile, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import { useModels } from '../../lib/api.ts'
import { Button, Menu, MenuItem, MenuSeparator } from '../../components/ui.tsx'
import { compactModelLabel } from './model-label.ts'
import { ReasoningControl } from '../../components/reasoning-control.tsx'
import { ModelSelect } from '../../components/model-select.tsx'

export function ComposerControls({ story, disabled, openSettings, openContext, menu, menuTrigger, onMenuCloseAutoFocus, shortcuts, trailing, onProfileChange }: {
  story: Pick<StorySnapshot, 'profile'>; disabled: boolean; openSettings: () => void; openContext?: () => void; onProfileChange: (profile: StoryProfile) => void
  menu: ReactNode; menuTrigger: ReactElement; onMenuCloseAutoFocus: (event: Event) => void; shortcuts: ReactNode; trailing: ReactNode
}) {
  useUiLanguage()
  const models = useModels(), [modelOpen, setModelOpen] = useState(false)
  const runtime = story.profile.runtime, effective = runtime.provider && runtime.model ? runtime : models.data?.effectiveMain
  const model = models.data?.models.find(item => item.provider === effective?.provider && item.model === effective.model)
  const modelLabel = model?.label ?? effective?.model ?? uiT('默认模型')
  const modelName = model ? compactModelLabel(model) : modelLabel
  const save = (profile: StoryProfile) => {
    if (!disabled) onProfileChange(profile)
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm' && !event.isComposing && !disabled && !document.querySelector('[role="dialog"]')) { event.preventDefault(); setModelOpen(true) }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [disabled])
  return <>
    <div className="composer-toolbar">
    <Menu label={uiT('添加与快捷操作')} className="composer-add-menu" side="top" align="start" trigger={menuTrigger} onCloseAutoFocus={onMenuCloseAutoFocus}>
      {menu}
      <MenuSeparator /><MenuItem onSelect={openSettings}><SlidersHorizontal size={15} />{uiT("会话设置")}</MenuItem>
    </Menu>
    <ToggleGroup.Root type="single" className="composer-mode" aria-label={uiT('生成方式')} value={runtime.executionMode} disabled={disabled} onValueChange={executionMode => {
      if (executionMode === 'chat' || executionMode === 'agent') save({ ...story.profile, runtime: { ...runtime, executionMode } })
    }}>
      <ToggleGroup.Item value="chat" asChild><Button tone="quiet" title={uiT('Chat · 对话与创作')}>Chat</Button></ToggleGroup.Item>
      <ToggleGroup.Item value="agent" asChild><Button tone="quiet" title={uiT('Agent · 使用工具')}>Agent</Button></ToggleGroup.Item>
    </ToggleGroup.Root>
    <div className="composer-utilities">{shortcuts}</div>
    <div className="composer-model-controls">
    <ModelSelect trigger={<Button tone="quiet" className="composer-selector model-selector" disabled={disabled} title={modelLabel} aria-label={uiT("选择模型：%{v0}", { v0: modelLabel })} aria-haspopup="dialog" onClick={() => setModelOpen(true)}><span className="model-label-full">{modelLabel}</span><span className="model-label-compact">{modelName}</span><ChevronDown size={12} /></Button>} open={modelOpen} onOpenChange={setModelOpen} value={runtime.provider && runtime.model ? { provider: runtime.provider, model: runtime.model } : null}
      inheritLabel={uiT('跟随默认模型')} inheritDetail={models.data?.models.find(item => item.provider === models.data?.effectiveMain?.provider && item.model === models.data?.effectiveMain?.model)?.label}
      onChange={route => { const { provider: _provider, model: _model, reasoningEffort: _effort, ...rest } = runtime; save({ ...story.profile, runtime: { ...rest, ...(route ?? {}) } }) }}
      footer={<>{openContext && <Button tone="quiet" onClick={() => { setModelOpen(false); openContext() }}>{uiT('查看上下文占用')}</Button>}<Button tone="quiet" onClick={() => { setModelOpen(false); openSettings() }}>{uiT('Writer 与高级设置')}</Button></>} />{model?.thinkingLevels.some(level => level !== 'off') && <ReasoningControl levels={model.thinkingLevels} value={runtime.reasoningEffort}
      defaultLevel={(!runtime.model ? effective?.reasoningEffort : undefined) ?? model.defaultThinkingLevel}
      defaultLabel={runtime.model ? uiT('模型默认') : uiT('跟随默认设置')} disabled={disabled}
      onChange={reasoningEffort => save({ ...story.profile, runtime: { ...runtime, reasoningEffort } })} />}</div>
    <div className="composer-send-actions">{trailing}</div></div>
  </>
}
