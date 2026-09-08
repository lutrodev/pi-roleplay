import { StatusNotice } from '../../components/status-notice.tsx'
import { useLayoutEffect, useState } from 'react'
import type { StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import { storyVariables, type VariableSettings } from '../../../../../packages/rp-core/src/story/variables.ts'
import { api, refreshStory, useAction } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { EditorForm } from '../../components/form-guard.tsx'
import { SettingToggle } from '../../components/settings-controls.tsx'
import { SettingsGroup } from '../../components/settings-layout.tsx'
import { Button, ErrorNotice } from '../../components/ui.tsx'

export function StoryVariableSettings({ story, busy }: { story: StorySnapshot; busy: boolean }) {
  useUiLanguage()
  const [baseline, setBaseline] = useState(story), [value, setValue] = useState<VariableSettings>(() => ({ ...storyVariables(story.profile) }))
  const action = useAction(), [saved, setSaved] = useState(false)
  const dirty = JSON.stringify(value) !== JSON.stringify(storyVariables(baseline.profile))
  useLayoutEffect(() => {
    if (!dirty) { setBaseline(story); setValue({ ...storyVariables(story.profile) }) }
  }, [story.revision])
  const patch = (next: Partial<VariableSettings>) => { setValue(current => ({ ...current, ...next })); setSaved(false) }
  const disabled = busy || story.archived || story.maintenance.summary?.status === 'running'
  return <EditorForm className="stack variable-settings" dirty={dirty} busy={action.busy} onSubmit={() => {
    if (disabled) return
    void action.run(async () => {
      const { story: next } = await api<{ story: StorySnapshot }>(`/stories/${story.id}/profile`, 'PUT', {
        expectedRevision: baseline.revision, profile: { ...baseline.profile, variables: value },
      })
      setBaseline(next); setValue({ ...storyVariables(next.profile) }); setSaved(true)
      await refreshStory(story.id)
    })
  }}>
    <SettingsGroup>
      <SettingToggle label={uiT('启用会话变量')} help={uiT('让变量参与本会话的生成和剧情更新。关闭后保留已有值与历史，不影响其他会话。')} checked={value.enabled} disabled={disabled} onChange={event => patch({ enabled: event.target.checked })} />
    </SettingsGroup>
    {!value.enabled && <StatusNotice compact tone={dirty ? 'info' : 'paused'} title={uiT(dirty ? '保存后暂停变量维护' : '变量维护已暂停')}><p>{uiT(dirty ? 'MVU 兼容也将暂停，已有变量会保留。' : 'MVU 兼容暂不执行，已有变量仍可在下方查看。')}</p></StatusNotice>}
    <details className="variable-compatibility"><summary>{uiT('高级兼容')}</summary>
      <SettingToggle label={uiT('MVU 角色卡兼容')} help={uiT('读取角色卡的 MVU 初始化与世界书兼容规则。导入资料始终保留兼容信息；关闭此项不会清除已有变量。')} checked={value.mvu} disabled={disabled || !value.enabled} onChange={event => patch({ mvu: event.target.checked })} />
      <p className="muted">{uiT('初始变量仅在故事开始前建立；故事开始后使用已保存的变量，不重新初始化。')}</p>
    </details>
    {disabled && <p className="muted">{uiT(story.archived ? '恢复会话后可以调整变量设置。' : '运行结束后可以调整变量设置。')}</p>}
    <ErrorNotice error={action.error} />
    <div className="form-actions"><span className="settings-save-status" role="status">{dirty ? uiT('有未保存的更改') : saved ? uiT('设置已保存') : ''}</span>
      <Button disabled={action.busy || !dirty} onClick={() => { setBaseline(story); setValue({ ...storyVariables(story.profile) }); setSaved(false); action.clear() }}>{uiT('放弃修改')}</Button>
      <Button type="submit" tone="primary" disabled={disabled || action.busy || !dirty}>{action.busy ? uiT('正在保存…') : uiT('保存变量设置')}</Button>
    </div>
  </EditorForm>
}
