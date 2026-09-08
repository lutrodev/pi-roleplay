import { uiT, uiLocale, useUiLanguage } from "../../../lib/i18n.ts"
import { motion, useReducedMotion } from 'motion/react'
import { BookOpen, Database, FileText, Globe, GripVertical, ListChecks, MessageSquare, UserRound, UsersRound, Feather } from 'lucide-react'
import type { ContextSlot } from '../../../../../../packages/rp-core/src/types.ts'
import { canIdlePromptSlot, movePromptSlot, movePromptSource, type PromptBuild, type PromptMaterial, type PromptSource } from '../../../../../../packages/rp-core/src/context/preview.ts'
import { Menu, MenuItem } from '../../../components/ui.tsx'
import type { usePromptDrag } from './drag.ts'

export const promptTones = [
  ['character', '角色卡'], ['conversation', '对话内容'], ['state', '会话变量'], ['lore', '世界书'],
  ['persona', '我的人设'], ['preset', '创作预设'], ['style', '文风'],
] as const
export function sourceTone(id: string) {
  if (id === 'rp.card') return 'character'
  if (id === 'rp.persona') return 'persona'
  if (id.startsWith('rp.lore')) return 'lore'
  if (id.startsWith('rp.preset:')) return 'preset'
  if (id.startsWith('rp.writing-style:')) return 'style'
  if (id.startsWith('rp.conversation') || id === 'rp.current-input') return 'conversation'
  if (id === 'rp.state') return 'state'
  return 'custom'
}
export function slotTone(slot: ContextSlot) {
  const tones = new Set(slot.sourceIds.map(sourceTone))
  return tones.size > 1 ? 'mixed' : [...tones][0] ?? 'custom'
}
export function PromptIcon({ tone }: { tone: string }) {
  useUiLanguage()
  const Icon = ({ character: UsersRound, conversation: MessageSquare, state: Database, lore: Globe,
    persona: UserRound, preset: ListChecks, style: Feather, custom: FileText, mixed: BookOpen } as const)[tone as 'custom'] ?? FileText
  return <span className="prompt-icon" data-tone={tone}><Icon size={16} aria-hidden="true" /></span>
}
export const formatPromptCount = (value: number) => value.toLocaleString(uiLocale())
function materialCount(slot: ContextSlot, materials: Map<string, PromptMaterial>) {
  if (slot.sourceIds.length === 1) {
    const id = slot.sourceIds[0]!, item = materials.get(id)
    if (id === 'rp.current-input' && !item?.available) return uiT("等待输入")
    if (item?.messageCount !== undefined) return uiT("%{v0} 条消息", { v0: formatPromptCount(item.messageCount) })
    if (id === 'rp.state' && !item?.available) return uiT("尚未初始化")
  }
  const characters = slot.sourceIds.reduce((sum, id) => sum + [...(materials.get(id)?.text ?? '')].length, 0)
  return characters ? uiT("%{v0} 字符", { v0: formatPromptCount(characters) }) : uiT("暂时没有内容")
}

interface Props {
  slot: ContextSlot; index: number; build: PromptBuild; catalog: PromptSource[]; materials: Map<string, PromptMaterial>
  visible: ContextSlot[]; selected: boolean; disabled: boolean; drag: ReturnType<typeof usePromptDrag>
  change: (value: PromptBuild) => void; edit: (id: string) => void
}
export function PromptGroupCard({ slot, index, build, catalog, materials, visible, selected, disabled, drag, change, edit }: Props) {
  useUiLanguage()
  const reduced = useReducedMotion(), canIdle = canIdlePromptSlot(slot, catalog)
  const custom = slot.id.startsWith('custom-'), ownId = `rp.custom:${slot.id}`
  const canDelete = custom && !slot.locked && slot.sourceIds.every(id => id === ownId)
  const area = slot.idle ? build.slots.filter(item => item.idle) : visible
  const groupIndex = area.findIndex(item => item.id === slot.id)
  const moveGroup = (by: number) => {
    const next = groupIndex + by
    if (next < 0 || next >= area.length) return
    change(movePromptSlot(build, slot.id, !!slot.idle, area[next + (by > 0 ? 1 : 0)]?.id ?? null, catalog))
  }
  const target = drag.drag?.target, sourceDrop = target?.slotId === slot.id && target.allowed
  const groupDrop = drag.drag?.item.kind === 'slot' && target?.area === (slot.idle ? 'idle' : 'active') && target.beforeId === slot.id
  const dragging = drag.drag?.item.kind === 'slot' && drag.drag.item.id === slot.id
  const single = slot.sourceIds.length === 1
  const sourceRow = (id: string, sourceIndex: number) => {
    const source = catalog.find(item => item.id === id), label = materials.get(id)?.label ?? source?.label ?? slot.label
    const movable = !disabled && !slot.idle && !slot.locked && !source?.defaultSlot.locked && !id.startsWith('rp.custom:')
    const cross = (by: number) => {
      const position = visible.findIndex(item => item.id === slot.id)
      const next = visible[position + by]
      if (next) change(movePromptSource(build, id, next.id, null, catalog))
    }
    return <div key={id} className={single ? 'prompt-single-source' : 'prompt-source-row'} data-prompt-source={id}
      data-source-before={sourceDrop && target.beforeId === id || undefined}>
      <button type="button" className="prompt-source-handle" aria-label={uiT("拖动资料 %{v0}；上下键%{v1}", { v0: label, v1: single ? uiT("跨组移动") : uiT("排序，Alt 加上下键跨组移动") })}
        disabled={!movable} onPointerDown={event => drag.start(event, { kind: 'source', id }, label)}
        onKeyDown={event => {
          if (!movable || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
          event.preventDefault(); const by = event.key === 'ArrowUp' ? -1 : 1
          if (single || event.altKey) cross(by)
          else if (sourceIndex + by >= 0 && sourceIndex + by < slot.sourceIds.length) change(movePromptSource(build, id, slot.id, slot.sourceIds[sourceIndex + by + (by > 0 ? 1 : 0)] ?? null, catalog))
        }}><PromptIcon tone={sourceTone(id)} /><GripVertical className="prompt-source-grip" size={10} /></button>
      {!single && <span>{label}</span>}
    </div>
  }
  return <motion.article layout="position" transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 480, damping: 38 }}
    className="prompt-group" data-tone={slotTone(slot)} data-prompt-slot={slot.id} data-selected={selected || undefined}
    data-dragging={dragging || undefined} data-drop-before={groupDrop || undefined} data-source-drop={sourceDrop || undefined}>
    <div className="prompt-group-heading">
      <button type="button" className="prompt-group-handle" disabled={disabled || slot.locked} aria-label={uiT("拖动分组 %{v0}；上下方向键排序", { v0: slot.label })}
        onPointerDown={event => drag.start(event, { kind: 'slot', id: slot.id }, slot.label)} onKeyDown={event => {
          if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); moveGroup(event.key === 'ArrowUp' ? -1 : 1) }
        }}><GripVertical size={16} /></button>
      {single ? sourceRow(slot.sourceIds[0]!, 0) : <PromptIcon tone={slotTone(slot)} />}
      <div className="prompt-group-info">
      <div className="prompt-group-label">
      <button className="prompt-group-title" type="button" disabled={disabled} title={custom ? uiT("编辑这个分组的名称与内容；也可拖动分组") : uiT("拖动分组调整顺序或移入闲置区")}
        onPointerDown={event => { if (event.pointerType !== 'touch' && !slot.locked) drag.start(event, { kind: 'slot', id: slot.id }, slot.label) }}
        onClick={() => { if (custom) edit(slot.id) }}><strong>{slot.label}</strong></button>
      {!canIdle && <span className="prompt-required">{uiT("始终使用")}</span>}
      </div>
      <div className="prompt-group-meta">
      <span className="prompt-group-count"><small>{uiT("第 %{index} 组", { index: index + 1 })}</small><span>{materialCount(slot, materials)}</span></span>
      </div></div>
      <Menu label={uiT("%{v0}分组操作", { v0: slot.label })}><MenuItem disabled={disabled || slot.locked || groupIndex === 0} onSelect={() => moveGroup(-1)}>{uiT("上移分组")}</MenuItem>
        <MenuItem disabled={disabled || slot.locked || groupIndex === area.length - 1} onSelect={() => moveGroup(1)}>{uiT("下移分组")}</MenuItem>
        <MenuItem disabled={disabled || !canIdle} onSelect={() => change(movePromptSlot(build, slot.id, !slot.idle, null, catalog))}>{slot.idle ? uiT("恢复使用") : uiT("移入闲置区")}</MenuItem>
        {custom && <MenuItem disabled={disabled} onSelect={() => edit(slot.id)}>{uiT("编辑分组")}</MenuItem>}
        {custom && <MenuItem danger disabled={disabled || !canDelete} onSelect={() => change({ ...build, slots: build.slots.filter(item => item.id !== slot.id), customSources: build.customSources?.filter(item => item.slotId !== slot.id) })}>{uiT("删除分组")}</MenuItem>}
      </Menu>
    </div>
    {!single && !!slot.sourceIds.length && <div className="prompt-group-sources">{slot.sourceIds.map(sourceRow)}</div>}
    {sourceDrop && target.beforeId === null && <div className="prompt-source-end">{uiT("放入这个分组")}</div>}
  </motion.article>
}
