import type { JsonObject } from '../../../../../packages/rp-core/src/types.ts'

const sections = [['personality', '性格'], ['scenario', '背景'], ['firstMessage', '说话方式示例']] as const

/** One editable description, without losing text from existing structured personas. */
export function consolidatePersonaDescription(source: JsonObject): JsonObject {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('人设资料必须是对象。')
  const draft = { ...source }
  const parts: string[] = []
  for (const key of ['description', ...sections.map(([key]) => key)]) {
    if (source[key] != null && typeof source[key] !== 'string') throw new Error('人设描述、性格、背景和说话方式必须是文字。')
  }
  if (typeof source.description === 'string' && source.description.trim()) parts.push(source.description)
  for (const [key, label] of sections) {
    const text = source[key]
    if (typeof text === 'string' && text.trim()) parts.push(`${label}：${text}`)
    delete draft[key]
  }
  draft.description = parts.join('\n\n')
  return draft
}
