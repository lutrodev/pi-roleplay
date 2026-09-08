import type { AssetKind, AssetRecord, JsonObject, StoryProfile } from '../../../../../packages/rp-core/src/types.ts'

export const materialGroups = [
  { id: 'people', label: '人物', description: '角色与我的人设', kinds: ['character', 'persona'] },
  { id: 'world', label: '世界', description: '背景、地点与规则', kinds: ['lorebook'] },
  { id: 'writing', label: '写作', description: '创作预设与文风', kinds: ['preset', 'writingStyle'] },
] as const
const bindingKey = { character: 'card', persona: 'persona', preset: 'preset', lorebook: 'lorebooks', writingStyle: 'writingStyles' } as const
export type MaterialReference = { id: string; kind: AssetKind }
export function materialReferences(profile: StoryProfile): MaterialReference[] {
  return materialGroups.flatMap(group => group.kinds.flatMap(kind => {
    const value = profile.resources[bindingKey[kind]], ids = Array.isArray(value) ? value.map(item => item.id) : value ? [value.id] : []
    return [...new Set(ids)].map(id => ({ id, kind }))
  }))
}

export type MaterialSection = { id: string; label: string; text: string; secondary?: boolean }
/** The reader exposes authored content, not the library's import payload or editor configuration. */
export function materialSections(asset: AssetRecord): MaterialSection[] {
  const fields = [
    ['description', asset.kind === 'character' ? '角色介绍' : asset.kind === 'persona' ? '人设介绍' : '简介'],
    ['personality', '性格'], ['scenario', '故事场景'], ['content', '写作要求'],
    ['firstMessage', asset.kind === 'persona' ? '说话方式示例' : '默认开场'], ['messageExample', '对话示例'], ['creatorNotes', '作者备注'],
  ] as const
  const sections: MaterialSection[] = fields.flatMap(([id, label]) => typeof asset.data[id] === 'string' && asset.data[id].trim()
    ? [{ id, label, text: asset.data[id], secondary: ['firstMessage', 'messageExample', 'creatorNotes'].includes(id) }] : [])
  for (const key of ['alternateGreetings', 'groupOnlyGreetings'] as const) {
    const values = asset.data[key]
    if (Array.isArray(values)) values.forEach((text, index) => {
      if (typeof text === 'string' && text.trim()) sections.push({ id: `${key}-${index}`, label: key === 'alternateGreetings' ? '其他开场' : '群聊开场', text, secondary: true })
    })
  }
  const accepted = asset.data.acceptedPromptPaths, prompts = asset.data.quarantinedPrompts
  if (Array.isArray(accepted) && Array.isArray(prompts)) for (const prompt of prompts) {
    if (prompt && typeof prompt === 'object' && !Array.isArray(prompt) && typeof prompt.path === 'string' && typeof prompt.value === 'string' && accepted.includes(prompt.path)) {
      sections.push({ id: `prompt-${prompt.path}`, label: '附加提示', text: prompt.value, secondary: true })
    }
  }
  return sections
}
export function materialEntries(asset: AssetRecord): JsonObject[] {
  const value = asset.kind === 'preset' ? asset.data.fields : asset.kind === 'lorebook' ? asset.data.entries : undefined
  return Array.isArray(value) ? value.filter((entry): entry is JsonObject => !!entry && typeof entry === 'object' && !Array.isArray(entry)) : []
}
export function entrySearchText(entry: JsonObject) {
  return [entry.name, entry.content, entry.description, entry.keys, entry.secondaryKeys, entry.stateCondition].flat().filter(value => typeof value === 'string').join('\n')
}
export function materialMatches(asset: AssetRecord, query: string) {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || [asset.name, ...materialSections(asset).map(section => `${section.label}\n${section.text}`), ...materialEntries(asset).map(entrySearchText)].some(text => text.toLocaleLowerCase().includes(needle))
}
export function materialExcerpt(asset: AssetRecord, query = '') {
  const sections = materialSections(asset), entries = materialEntries(asset)
  const needle = query.trim().toLocaleLowerCase()
  const texts = [...sections.map(section => section.text), ...entries.map(entrySearchText)]
  const text = (needle ? texts.find(text => text.toLocaleLowerCase().includes(needle)) : undefined) ?? texts[0] ?? ''
  const start = needle ? Math.max(0, text.toLocaleLowerCase().indexOf(needle) - 24) : 0
  return `${start ? '…' : ''}${text.slice(start, start + 140).replace(/\s+/g, ' ')}${text.length > start + 140 ? '…' : ''}`
}
