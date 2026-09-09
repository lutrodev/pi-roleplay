import { normalizeModelSelection } from '../agents/catalog.ts'
import { objectInput } from '../input.ts'
import { RpError, requireValue } from '../errors.ts'
import { DEFAULT_QUICK_REPLIES, normalizeQuickReplies } from '../interaction/quick-replies.js'
import { assertReplyOptionKeywords, normalizeReplyOptionMaxCharacters, normalizeReplyOptionsCount } from '../interaction/reply-options.js'
import type { ModelRoute } from '../types.ts'

export const DIALOGUE_COLORS = ['orange', 'green', 'blue', 'purple', 'rose'] as const
export type DialogueColor = typeof DIALOGUE_COLORS[number]
export const ITALIC_COLORS = ['teal', 'indigo', 'plum', 'olive', 'slate'] as const
export type ItalicColor = typeof ITALIC_COLORS[number]

export interface Preferences {
  language: 'zh' | 'en'
  mainModel: ModelRoute | null
  quickRepliesEnabled: boolean
  replyOptionsEnabled: boolean
  subagentsEnabled: boolean
  skills: boolean
  disabledSkills: string[]
  identity: string
  transcriptView: 'normal' | 'compact'
  busyEnter: 'queue' | 'steer'
  quickReplies: { id: string; label: string; content: string; cursorPosition: 'middle' | 'end' }[]
  replyOptions: { count: number; maxCharacters: number; keywords: string[] }
  reading: { theme: 'system' | 'light' | 'dark'; fontFamily: 'sans' | 'serif'; fontSize: number; lineHeight: number; maxWidth: number; dialogueColor: DialogueColor; dialogueHighlight: boolean; italicColor: ItalicColor; italicHighlight: boolean; showAvatars: boolean; showStateCard: boolean }
}
export const DEFAULT_PREFERENCES: Preferences = {
  language: 'zh', mainModel: null, quickRepliesEnabled: true, replyOptionsEnabled: true, subagentsEnabled: true, skills: true, disabledSkills: [], identity: '', transcriptView: 'compact', busyEnter: 'queue',
  quickReplies: DEFAULT_QUICK_REPLIES.map(item => ({ ...item })),
  replyOptions: { count: 3, maxCharacters: 50, keywords: ['', '', ''] },
  reading: { theme: 'system', fontFamily: 'sans', fontSize: 16, lineHeight: 1.85, maxWidth: 640, dialogueColor: 'orange', dialogueHighlight: true, italicColor: 'teal', italicHighlight: true, showAvatars: true, showStateCard: true },
}

export function normalizePreferences(input: unknown): Preferences {
  objectInput(input)
  requireValue(Object.keys(input).length === Object.keys(DEFAULT_PREFERENCES).length && Object.keys(input).every(key => Object.hasOwn(DEFAULT_PREFERENCES, key)), 'INVALID_SETTINGS', '请提交完整的设置，不可包含未知字段。')
  requireValue(input.language === 'zh' || input.language === 'en', 'INVALID_SETTINGS', '界面语言不正确。')
  for (const key of ['quickRepliesEnabled', 'replyOptionsEnabled', 'subagentsEnabled']) requireValue(typeof input[key] === 'boolean', 'INVALID_SETTINGS', '启用状态必须是布尔值。')
  requireValue(typeof input.skills === 'boolean', 'INVALID_SETTINGS', 'Skills 开关必须是布尔值。')
  requireValue(Array.isArray(input.disabledSkills) && input.disabledSkills.length <= 128 && input.disabledSkills.every(name => typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64) && new Set(input.disabledSkills).size === input.disabledSkills.length, 'INVALID_SETTINGS', '停用的 Skills 列表不正确。')
  requireValue(typeof input.identity === 'string' && [...input.identity].length <= 4000, 'INVALID_SETTINGS', '身份提示词不能超过 4000 字。')
  requireValue(input.transcriptView === 'normal' || input.transcriptView === 'compact', 'INVALID_SETTINGS', '对话显示模式不正确。')
  requireValue(input.busyEnter === 'queue' || input.busyEnter === 'steer', 'INVALID_SETTINGS', '繁忙时的输入行为不正确。')
  let mainModel: ModelRoute | null = null
  if (input.mainModel !== null) {
    objectInput(input.mainModel)
    requireValue(Object.keys(input.mainModel).every(key => ['provider', 'model', 'reasoningEffort'].includes(key)), 'INVALID_SETTINGS', '主模型选择包含不支持的字段。')
    const selection = normalizeModelSelection({ ...input.mainModel, kind: 'fixed' })
    if (selection.kind === 'fixed') { const { kind: _kind, ...route } = selection; mainModel = route }
  }
  objectInput(input.replyOptions); objectInput(input.reading)
  requireValue(Object.keys(input.replyOptions).sort().join(',') === 'count,keywords,maxCharacters', 'INVALID_SETTINGS', '回复选项需要数量、长度和方向关键词。')
  requireValue(typeof input.replyOptions.count === 'number' && typeof input.replyOptions.maxCharacters === 'number', 'INVALID_SETTINGS', '回复选项的数量和长度必须是整数。')
  const reading = input.reading
  requireValue(Object.keys(reading).sort().join(',') === 'dialogueColor,dialogueHighlight,fontFamily,fontSize,italicColor,italicHighlight,lineHeight,maxWidth,showAvatars,showStateCard,theme' && ['sans', 'serif'].includes(String(reading.fontFamily)) && ['system', 'light', 'dark'].includes(String(reading.theme)) && Number.isInteger(reading.fontSize) && Number(reading.fontSize) >= 14 && Number(reading.fontSize) <= 26 && typeof reading.lineHeight === 'number' && reading.lineHeight >= 1.4 && reading.lineHeight <= 2.2 && Number.isInteger(reading.maxWidth) && Number(reading.maxWidth) >= 640 && Number(reading.maxWidth) <= 1100, 'INVALID_SETTINGS', '阅读设置的字体、行高或正文宽度超出范围。')
  requireValue(['dialogueHighlight', 'italicHighlight', 'showAvatars', 'showStateCard'].every(key => typeof reading[key] === 'boolean'), 'INVALID_SETTINGS', '消息显示设置必须是布尔值。')
  requireValue(DIALOGUE_COLORS.includes(reading.dialogueColor as DialogueColor), 'INVALID_SETTINGS', '请选择可用的对白高亮颜色。')
  requireValue(ITALIC_COLORS.includes(reading.italicColor as ItalicColor), 'INVALID_SETTINGS', '请选择可用的斜体高亮颜色。')
  try {
    const count = normalizeReplyOptionsCount(input.replyOptions.count)
    return { language: input.language, mainModel, quickRepliesEnabled: input.quickRepliesEnabled as boolean, replyOptionsEnabled: input.replyOptionsEnabled as boolean, subagentsEnabled: input.subagentsEnabled as boolean, skills: input.skills, disabledSkills: [...input.disabledSkills] as string[], identity: input.identity.trim(), transcriptView: input.transcriptView, busyEnter: input.busyEnter,
      quickReplies: normalizeQuickReplies(input.quickReplies) as Preferences['quickReplies'],
      replyOptions: { count, maxCharacters: normalizeReplyOptionMaxCharacters(input.replyOptions.maxCharacters), keywords: assertReplyOptionKeywords(input.replyOptions.keywords, count) },
      reading: structuredClone(reading) as unknown as Preferences['reading'],
    }
  } catch (error) { throw new RpError('INVALID_SETTINGS', '快捷回复或回复选项的格式不正确。', 400, error instanceof Error ? error.message : undefined) }
}
