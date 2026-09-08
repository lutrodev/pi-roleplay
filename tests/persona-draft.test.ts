import { expect, it } from 'vitest'
import { consolidatePersonaDescription } from '../apps/web/src/pages/library/persona-draft.ts'
import { normalizeAsset } from '../packages/rp-core/src/assets/normalize.ts'
import { renderPersona } from '../packages/rp-core/src/assets/persona.js'
import { fixture } from './helpers.ts'

it('consolidates existing persona sections without changing user text, macros or classification tags', () => {
  const source = { name: '旅人', description: '我叫 {{user}}。\n保留这段原文。', personality: '沉静🌿', scenario: '从雾港归来。', firstMessage: '“先听我说。”', tags: ['旧分类', '旅人'] }
  const original = structuredClone(source)
  expect(consolidatePersonaDescription(source)).toEqual({ name: source.name, description: '我叫 {{user}}。\n保留这段原文。\n\n性格：沉静🌿\n\n背景：从雾港归来。\n\n说话方式示例：“先听我说。”', tags: source.tags })
  expect(source).toEqual(original)
})

it('does not add empty headings or duplicate content across editor reopen and save', () => {
  const draft = consolidatePersonaDescription({ name: '旅人', scenario: '仍在旅途', personality: '', firstMessage: null })
  expect(draft).toEqual({ name: '旅人', description: '背景：仍在旅途' })
  expect(consolidatePersonaDescription(draft)).toEqual(draft)
  const stored = normalizeAsset('persona', draft)
  expect(consolidatePersonaDescription(stored).description).toBe(draft.description)
})

it('saves one description while preserving shared identity, tags and every prompt detail exactly once', () => {
  const x = fixture()
  try {
    const asset = x.assets.create('persona', { name: '旧旅人', description: '已有描述', personality: '旧性格', scenario: '旧经历', firstMessage: '旧口吻', tags: ['保留标签'] })
    const draft = consolidatePersonaDescription(asset.data)
    const updated = x.assets.update(asset.id, asset.revision, { ...draft, name: '新旅人' })
    expect(updated.id).toBe(asset.id)
    expect(updated.data).toMatchObject({ personality: '', scenario: '', firstMessage: '', tags: ['保留标签'] })
    const prompt = renderPersona(updated.data)
    for (const text of ['已有描述', '旧性格', '旧经历', '旧口吻']) expect(prompt.split(text)).toHaveLength(2)
    expect(prompt).not.toContain('example_voice:')
    expect(consolidatePersonaDescription(updated.data)).toEqual({ ...draft, name: '新旅人' })
  } finally { x.close() }
})

it('keeps invalid and unknown advanced edits observable instead of silently dropping them', () => {
  expect(() => consolidatePersonaDescription({ name: '旅人', personality: { text: '错误类型' } })).toThrow('必须是文字')
  expect(() => consolidatePersonaDescription(null as never)).toThrow('必须是对象')
  expect(() => consolidatePersonaDescription([] as never)).toThrow('必须是对象')
  const unknown = consolidatePersonaDescription({ name: '旅人', description: '描述', unexpected: true })
  expect(() => normalizeAsset('persona', unknown)).toThrow('格式不正确')
})
