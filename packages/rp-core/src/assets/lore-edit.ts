import { objectInput } from '../input.ts'
import { requireValue } from '../errors.ts'

const LORE_FIELDS = ['id', 'name', 'content', 'level', 'semanticKey', 'keys', 'secondaryKeys', 'stateCondition', 'enabled', 'constant', 'caseSensitive', 'recursive', 'order', 'position', 'insertionPosition', 'depth', 'probability']

export function validateEditableLoreEntries(input: unknown) {
  requireValue(Array.isArray(input) && input.length <= 4096, 'INVALID_LOREBOOK', '请提供完整的世界书条目列表，最多 4096 条。')
  const ids = new Set<string>()
  for (const entry of input) {
    objectInput(entry); requireValue(Object.keys(entry).every(key => LORE_FIELDS.includes(key)), 'INVALID_ASSET_FIELDS', '世界书条目包含不可编辑的字段。')
    for (const field of ['id', 'name', 'content']) requireValue(typeof entry[field] === 'string' && entry[field].trim().length > 0, 'INVALID_LOREBOOK', `世界书条目缺少有效的 ${field}。`)
    requireValue(!ids.has(entry.id as string), 'INVALID_LOREBOOK', '世界书条目 ID 重复。'); ids.add(entry.id as string)
    requireValue(['worldDescription', 'roleplayGuide', 'importantRules'].includes(entry.level as string), 'INVALID_LOREBOOK', '世界书条目需要明确的用途层级。')
    for (const field of ['keys', 'secondaryKeys']) requireValue(entry[field] === undefined || Array.isArray(entry[field]) && entry[field].every(item => typeof item === 'string' && item.trim()), 'INVALID_LOREBOOK', '世界书关键词必须是非空文字列表。')
    for (const field of ['enabled', 'constant', 'caseSensitive', 'recursive']) requireValue(entry[field] === undefined || typeof entry[field] === 'boolean', 'INVALID_LOREBOOK', `${field} 必须是布尔值。`)
    const primary = (entry.keys as string[] | undefined) ?? [], secondary = (entry.secondaryKeys as string[] | undefined) ?? []
    requireValue(secondary.length === 0 || primary.length > 0, 'INVALID_LOREBOOK', '次关键词需要至少一个主关键词。')
    requireValue(entry.enabled === false || entry.constant === true || primary.length > 0, 'INVALID_LOREBOOK', '启用的世界书条目需要常驻设置或主关键词。')
    for (const field of ['semanticKey', 'stateCondition']) requireValue(entry[field] === undefined || typeof entry[field] === 'string' && entry[field].trim(), 'INVALID_LOREBOOK', `${field} 必须是非空文本。`)
    for (const field of ['order', 'position', 'depth']) requireValue(entry[field] === undefined || Number.isSafeInteger(entry[field]) && (field === 'order' || Number(entry[field]) >= 0), 'INVALID_LOREBOOK', `${field} 的整数取值不正确。`)
    requireValue(entry.insertionPosition === undefined || ['before_char', 'after_char', 'before_examples', 'after_examples', 'in_chat', 'before_an', 'after_an'].includes(entry.insertionPosition as string), 'INVALID_LOREBOOK', '世界书插入位置不正确。')
    requireValue(entry.probability === undefined || typeof entry.probability === 'number' && Number.isFinite(entry.probability) && entry.probability >= 0 && entry.probability <= 1, 'INVALID_LOREBOOK', '世界书概率必须在 0 到 1 之间。')
  }
}
