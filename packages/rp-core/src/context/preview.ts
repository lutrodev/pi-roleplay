import type { ContextSlot, StoryProfile } from '../types.ts'
import { contextBuildCustomDefinitions, reconcileChatContextBuild, renderContextText } from './build.js'
import { expandRoleplayMacros } from '../macro/syntax.js'

export type PromptBuild = NonNullable<StoryProfile['contextBuild']>
export interface PromptSource {
  id: string; label: string; description?: string; required: boolean; idleAllowed: boolean
  defaultSlot: { id: string; label: string; order: number; locked: boolean; sectionTag?: boolean }
}
export interface PromptMaterial { id: string; label: string; text: string; available: boolean; messageCount?: number }
export interface PromptInspection {
  layout: PromptBuild; catalog: PromptSource[]; previewSources: PromptMaterial[]
  identities: { characterName?: string; userName?: string }; diagnostics: unknown
  writerPrompt: string; parentPrompt: string; usedCharacters: number
}

export function normalizePromptBuild(value: StoryProfile['contextBuild'], catalog: PromptSource[]): PromptBuild {
  const definitions = [...catalog, ...contextBuildCustomDefinitions(value)]
  const normalized = reconcileChatContextBuild(value, definitions) as PromptBuild
  // Keep draft names editable (including an empty name); the UI validates before saving.
  return { ...normalized, slots: normalized.slots.map(slot => slot.id.startsWith('custom-')
    ? { ...slot, label: value?.slots.find(item => item.id === slot.id)?.label ?? slot.label } : slot), customSources: value?.customSources ?? [] }
}

export function promptMaterials(build: PromptBuild, inspection: PromptInspection): Map<string, PromptMaterial> {
  const materials = new Map(inspection.previewSources.map(source => [source.id, source]))
  for (const item of build.customSources ?? []) {
    const slot = build.slots.find(slot => slot.id === item.slotId)
    if (!slot) continue
    const text = expandRoleplayMacros(item.content.trim(), inspection.identities)
    materials.set(`rp.custom:${slot.id}`, { id: `rp.custom:${slot.id}`, label: slot.label.trim(), text, available: !!text })
  }
  return materials
}

/** The display includes an explicit future-input placeholder; actualText excludes it and equals the server's Writer material. */
export function promptDocument(build: PromptBuild, inspection: PromptInspection) {
  const materials = promptMaterials(build, inspection), slots = build.slots.filter(slot => !slot.idle).map(slot => ({ ...slot, label: slot.label.trim() }))
  const admitted = new Set([...materials.values()].filter(source => source.available).map(source => source.id))
  const actualText = renderContextText(slots, materials, admitted) as string
  const display = new Map(materials), displayIds = new Set(admitted)
  if (!admitted.has('rp.current-input')) {
    display.set('rp.current-input', { id: 'rp.current-input', label: '当前输入', text: '本轮用户消息会在开始生成时填入。', available: true })
    displayIds.add('rp.current-input')
  }
  const groups = slots.flatMap(slot => {
    const sourceIds = slot.sourceIds.filter(id => displayIds.has(id))
    if (!sourceIds.length) return []
    const text = renderContextText([slot], display, displayIds) as string
    return [{ ...slot, sourceIds, text, characters: [...text].length }]
  })
  return { actualText, characters: [...actualText].length, groups, text: groups.map(group => group.text).join('\n') }
}

export function canIdlePromptSlot(slot: ContextSlot, catalog: PromptSource[]) {
  return !slot.locked && !slot.sourceIds.some(id => catalog.find(source => source.id === id)?.idleAllowed === false)
}

export function movePromptSlot(build: PromptBuild, id: string, idle: boolean, beforeId: string | null, catalog: PromptSource[]): PromptBuild {
  const slot = build.slots.find(item => item.id === id)
  if (!slot || slot.locked || id === beforeId || idle && !canIdlePromptSlot(slot, catalog)) return build
  const rest = build.slots.filter(item => item.id !== id), target = rest.filter(item => !!item.idle === idle)
  const index = beforeId === null ? target.length : target.findIndex(item => item.id === beforeId)
  if (index < 0) return build
  target.splice(index, 0, { ...slot, idle })
  // Preserve locked groups in their absolute places, including when an unlocked group crosses them.
  const ordered = idle ? [...rest.filter(item => !item.idle), ...target] : [...target, ...rest.filter(item => item.idle)]
  const unlocked = ordered.filter(item => !item.locked)
  return { ...build, slots: build.slots.map(item => item.locked ? item : unlocked.shift()!) }
}

export function movePromptSource(build: PromptBuild, id: string, slotId: string, beforeId: string | null, catalog: PromptSource[]): PromptBuild {
  const source = catalog.find(item => item.id === id), origin = build.slots.find(slot => slot.sourceIds.includes(id)), target = build.slots.find(slot => slot.id === slotId)
  if (!origin || !target || target.idle || target.locked || origin.locked || id.startsWith('rp.custom:') || source?.defaultSlot.locked || id === beforeId) return build
  if (beforeId !== null && !target.sourceIds.includes(beforeId)) return build
  const slots = build.slots.map(slot => ({ ...slot, sourceIds: slot.sourceIds.filter(sourceId => sourceId !== id) }))
  const next = slots.find(slot => slot.id === slotId)!
  next.sourceIds.splice(beforeId === null ? next.sourceIds.length : next.sourceIds.indexOf(beforeId), 0, id)
  return { ...build, slots }
}

export function visiblePromptSlots(build: PromptBuild, catalog: PromptSource[], materials: Map<string, PromptMaterial>, draggingSource: boolean) {
  return build.slots.filter(slot => !slot.idle && (draggingSource || slot.id.startsWith('custom-') || slot.sourceIds.some(id => materials.get(id)?.available || catalog.find(source => source.id === id)?.required)))
}
