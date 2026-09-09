import { EditorFooter } from '../../components/editor-footer.tsx'
import { SettingRow, SettingsGroup } from '../../components/settings-layout.tsx'
import { CancelButton, EditorForm } from '../../components/form-guard.tsx'
import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { AssetKind, StoryProfile, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import { api, refreshStory, useAction, useAsset } from '../../lib/api.ts'
import { AssetPicker, assetLabels } from '../../components/selectors.tsx'
import { Button, Field, IconButton, Input, Select, TabGroup, Textarea } from '../../components/ui.tsx'

import { RuntimeProfile } from './runtime-profile.tsx'
export function ProfileEditor({ story, done, initialTab = 'basics', disabled = false }: { story: StorySnapshot; done: () => void; initialTab?: 'basics' | 'models'; disabled?: boolean }) {
  useUiLanguage()
  const [value, setValue] = useState<StoryProfile>(() => structuredClone(story.profile)), [savedProfile, setSavedProfile] = useState(story.profile), [revision, setRevision] = useState(story.revision), [tab, setTab] = useState<'basics' | 'models'>(initialTab)
  const action = useAction(), card = useAsset(value.resources.card?.id)
  const started = story.messages.some(message => message.kind !== 'opening')
  const patch = (next: Partial<StoryProfile>) => setValue(current => ({ ...current, ...next }))
  return <EditorForm dirty={JSON.stringify(value) !== JSON.stringify(savedProfile)} busy={disabled || action.busy} className="stack" onSubmit={event => { event.preventDefault(); if (disabled) return; void action.run(async () => {
    const { story: next } = await api<{ story: StorySnapshot }>(`/stories/${story.id}/profile`, 'PUT', { expectedRevision: revision, profile: value })
    setValue(next.profile); setSavedProfile(next.profile); setRevision(next.revision); await refreshStory(story.id); done()
  }) }}>
    <TabGroup value={tab} onChange={setTab} label={uiT("会话设置分类")} items={[{ value: 'basics', label: uiT("角色与资料") }, { value: 'models', label: uiT("创作方式") }]}><div className="stack">
    {tab === 'basics' && <>
      <SettingsGroup layout="form" title={uiT("出场角色与控制权")}>{value.cast.map((member, index) => <div className="cast-row" key={member.characterId}><Field label={uiT("角色名称")}><Input value={member.name ?? ''} onChange={event => patch({ cast: value.cast.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} /></Field><Field label={uiT("由谁扮演")}><Select value={member.controller} onChange={event => { const controller = event.target.value as 'user' | 'agent'; patch({ cast: value.cast.map((item, i) => i === index ? { ...item, controller } : controller === 'user' ? { ...item, controller: 'agent' } : item), playerCharacterId: controller === 'user' ? member.characterId : value.playerCharacterId === member.characterId ? undefined : value.playerCharacterId }) }}><option value="user">{uiT("我")}</option><option value="agent">AI</option></Select></Field><IconButton label={uiT("移除出场角色")} onClick={() => patch({ cast: value.cast.filter((_, i) => i !== index), playerCharacterId: value.playerCharacterId === member.characterId ? undefined : value.playerCharacterId })}><Trash2 size={16} /></IconButton></div>)}<Button onClick={() => patch({ cast: [...value.cast, { characterId: crypto.randomUUID(), name: '', controller: 'agent' }] })}><Plus size={15} />{uiT("添加出场角色")}</Button></SettingsGroup>
      <SettingsGroup title={uiT("本会话使用的资料")}>{(['character', 'persona', 'lorebook', 'preset', 'writingStyle'] as const).map(kind => {
        const key = ({ character: 'card', persona: 'persona', lorebook: 'lorebooks', preset: 'preset', writingStyle: 'writingStyles' } as const)[kind]
        const selected = value.resources[key], ids = Array.isArray(selected) ? selected.map(item => item.id) : selected ? [selected.id] : []
        return <SettingRow kind="field" label={uiT(assetLabels[kind])} key={kind}><AssetPicker kind={kind as AssetKind} ids={ids} multiple={kind === 'lorebook' || kind === 'writingStyle'} onChange={ids => {
          const resources = { ...value.resources, [key]: kind === 'lorebook' || kind === 'writingStyle' ? ids.map(id => ({ id })) : ids[0] ? { id: ids[0] } : undefined }
          const openingText = story.messages.find(message => message.kind === 'opening')?.text
          const scene = kind === 'character' && !started && value.scene.openingSource === 'card'
            ? ids.length ? { ...value.scene, openingIndex: 0 } : { title: value.scene.title, openingSource: openingText ? 'custom' as const : 'skip' as const, ...(openingText ? { openingText } : {}) }
            : value.scene
          patch({ resources, scene })
        }} /></SettingRow>
      })}{!!card.data?.associatedLorebooks.length && <Button onClick={() => patch({ resources: { ...value.resources, lorebooks: [...new Set([...value.resources.lorebooks.map(book => book.id), ...card.data!.associatedLorebooks.map(book => book.id)])].map(id => ({ id })) } })}>{uiT("加入角色卡关联世界书")}</Button>}</SettingsGroup>
      <SettingsGroup><Field layout="row" label={uiT("当前场景名称")}><Input value={value.scene.title ?? ''} onChange={event => patch({ scene: { ...value.scene, title: event.target.value } })} /></Field>
      {!started && <><Field layout="row" label={uiT("开场方式")}><Select value={value.scene.openingSource ?? 'skip'} onChange={event => patch({ scene: { title: value.scene.title, openingSource: event.target.value as 'card' | 'custom' | 'skip', ...(event.target.value === 'card' ? { openingIndex: 0 } : event.target.value === 'custom' ? { openingText: story.messages[0]?.text ?? '' } : {}) } })}><option value="skip">{uiT("从我的第一条消息开始")}</option><option value="card" disabled={!value.resources.card}>{uiT("角色卡开场")}</option><option value="custom">{uiT("自定义开场")}</option></Select></Field>{value.scene.openingSource === 'card' && <Field layout="row" label={uiT("开场序号")}><Select value={value.scene.openingIndex ?? 0} onChange={event => patch({ scene: { ...value.scene, openingIndex: Number(event.target.value) } })}>{[card.data?.asset.data.firstMessage, ...(Array.isArray(card.data?.asset.data.alternateGreetings) ? card.data.asset.data.alternateGreetings : [])].map((text, index) => <option key={index} value={index}>{index + 1} · {String(text ?? '').slice(0, 50)}</option>)}</Select></Field>}{value.scene.openingSource === 'custom' && <Field label={uiT("开场正文")}><Textarea rows={7} value={value.scene.openingText ?? ''} onChange={event => patch({ scene: { ...value.scene, openingText: event.target.value } })} /></Field>}</>}
      </SettingsGroup>
    </>}
    {tab === 'models' && <RuntimeProfile value={value.runtime} onChange={runtime => patch({ runtime })} />}
    </div></TabGroup>
    <EditorFooter error={action.error}><CancelButton onCancel={done} /><Button tone="primary" type="submit" disabled={disabled || action.busy}>{uiT("保存会话设置")}</Button></EditorFooter>
  </EditorForm>
}
