import { requireValue } from '../errors.ts'
import type { QuestionAnswer, QuestionItem } from '../types.ts'

function record(value: unknown): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_QUESTION', '问题与回答必须为完整对象。')
}
function text(value: unknown, maximum: number) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum, 'INVALID_QUESTION', `问题、选项或回答不能为空，且不能超过 ${maximum} 个字符。`)
  return value.trim()
}

export function normalizeQuestions(value: unknown): QuestionItem[] {
  requireValue(Array.isArray(value) && value.length >= 1 && value.length <= 8, 'INVALID_QUESTION', '一次可提交 1 到 8 个问题。')
  const ids = new Set<string>()
  return value.map(item => {
    record(item)
    const id = text(item.id, 80)
    requireValue(!ids.has(id), 'INVALID_QUESTION', '同一组问题的标识不能重复。'); ids.add(id)
    requireValue(item.multiSelect === undefined || typeof item.multiSelect === 'boolean', 'INVALID_QUESTION', '多选设置必须为布尔值。')
    requireValue(item.options === undefined || Array.isArray(item.options) && item.options.length <= 12, 'INVALID_QUESTION', '每个问题最多包含 12 个选项。')
    const labels = new Set<string>()
    const options = ((item.options ?? []) as unknown[]).map(option => {
      record(option)
      const label = text(option.label, 160)
      requireValue(!labels.has(label), 'INVALID_QUESTION', '选项名称不能重复。'); labels.add(label)
      return { label, ...(option.description === undefined ? {} : { description: text(option.description, 1000) }) }
    })
    return { id, question: text(item.question, 4000), options, multiSelect: item.multiSelect === true,
      ...(item.header === undefined ? {} : { header: text(item.header, 80) }) }
  })
}

export function normalizeAnswers(questions: QuestionItem[], value: unknown): QuestionAnswer[] {
  requireValue(Array.isArray(value) && value.length === questions.length, 'INVALID_ANSWER', '请回答全部问题后提交。')
  const answers = new Map<string, Record<string, unknown>>()
  for (const answer of value) {
    record(answer)
    requireValue(typeof answer.id === 'string' && questions.some(question => question.id === answer.id) && !answers.has(answer.id), 'INVALID_ANSWER', '回答的问题标识不正确或重复。')
    answers.set(answer.id, answer)
  }
  return questions.map(question => {
    const input = answers.get(question.id)!
    requireValue(Array.isArray(input.selected) && input.selected.every(label => typeof label === 'string' && question.options.some(option => option.label === label)), 'INVALID_ANSWER', '所选答案不在当前问题的选项中。')
    const selected = question.options.map(option => option.label).filter(label => (input.selected as string[]).includes(label))
    requireValue(new Set(input.selected).size === input.selected.length && (question.multiSelect || selected.length <= 1), 'INVALID_ANSWER', '该问题不允许重复选项或多个答案。')
    requireValue(input.custom === undefined || typeof input.custom === 'string' && input.custom.length <= 20_000, 'INVALID_ANSWER', '自定义回答最多为 20000 个字符。')
    const custom = typeof input.custom === 'string' ? input.custom.trim() : ''
    requireValue(selected.length > 0 || custom.length > 0, 'INVALID_ANSWER', '请选择答案或填写自定义回答。')
    return { id: question.id, selected, ...(custom ? { custom } : {}) }
  })
}
