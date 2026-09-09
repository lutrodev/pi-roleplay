
import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { ToggleGroup } from 'radix-ui'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import type { StoryProfile, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import { useModels } from '../../lib/api.ts'
import { ErrorNotice, Button, Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../../components/ui.tsx'
import { compactModelLabel } from './model-label.ts'
import { ReasoningControl } from '../../components/reasoning-control.tsx'

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
  const key = (provider?: string, model?: string) => provider && model ? JSON.stringify([provider, model]) : ''
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
    <div className="composer-model-controls"><Menu label={uiT("选择模型")} open={modelOpen} onOpenChange={setModelOpen} trigger={<Button tone="quiet" className="composer-selector model-selector" disabled={disabled} title={modelLabel} aria-label={uiT("选择模型：%{v0}", { v0: modelLabel })}><span className="model-label-full">{modelLabel}</span><span className="model-label-compact">{modelName}</span><ChevronDown size={12} /></Button>}>
      <MenuLabel>{uiT("当前会话模型")}</MenuLabel><MenuRadioGroup value={key(runtime.provider, runtime.model)} onValueChange={value => {
        const selected = models.data?.models.find(item => key(item.provider, item.model) === value)
        const { provider: _provider, model: _model, reasoningEffort: _effort, ...rest } = runtime
        save({ ...story.profile, runtime: { ...rest, ...(selected ? { provider: selected.provider, model: selected.model } : {}) } })
      }}><MenuRadioItem value="">{uiT("跟随默认模型")}</MenuRadioItem>{models.data?.models.map(item => <MenuRadioItem key={key(item.provider, item.model)} value={key(item.provider, item.model)} disabled={!item.configured}><span>{item.label}<small className="menu-description">{item.provider}{item.configured ? '' : uiT(" · 尚未配置")}</small></span></MenuRadioItem>)}</MenuRadioGroup>
      {openContext && <><MenuSeparator /><MenuItem onSelect={openContext}>{uiT("查看上下文占用")}</MenuItem></>}<ErrorNotice source="read" error={models.error} retry={() => void models.refetch()} retrying={models.isFetching} /><MenuSeparator /><MenuItem onSelect={openSettings}>{uiT('Writer 与高级设置')}</MenuItem>
    </Menu>{model?.thinkingLevels.some(level => level !== 'off') && <ReasoningControl levels={model.thinkingLevels} value={runtime.reasoningEffort}
      defaultLevel={(!runtime.model ? effective?.reasoningEffort : undefined) ?? model.defaultThinkingLevel}
      defaultLabel={runtime.model ? uiT('模型默认') : uiT('跟随默认设置')} disabled={disabled}
      onChange={reasoningEffort => save({ ...story.profile, runtime: { ...runtime, reasoningEffort } })} />}</div>
    <div className="composer-send-actions">{trailing}</div></div>
  </>
}
