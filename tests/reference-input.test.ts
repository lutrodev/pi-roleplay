import { describe, expect, it } from 'vitest'
import { completionAt, referenceText, withReferences } from '../apps/web/src/lib/reference-text.ts'
import { storyReferenceIds } from '../packages/rp-core/src/interaction/references.ts'
const a = '12345678-1234-4234-9234-123456789abc', b = '12345678-1234-4234-9234-123456789abd'

describe('readable references retain the generation protocol', () => {
  it('preserves deliberate newlines and trailing spaces through typing, restore and send', () => {
    for (const text of ['', ' ', '你好 ', '第一段\n\n第二段\n', '请结合这两段资料。']) {
      const wire = withReferences(text, [a, b, a])
      expect(referenceText(wire)).toEqual({ text, ids: [a, b] })
      expect(storyReferenceIds(wire)).toEqual([a, b])
    }
  })
  it('recognizes existing inline references and leaves unrelated text alone', () => {
    expect(referenceText(`比较 @story:${a} 与 @story:${b} 的设定。`)).toEqual({ text: '比较  与  的设定。', ids: [a, b] })
    const prose = `email@story:${a}\n引用的标点 @story:${b}。`
    expect(referenceText(prose)).toEqual({ text: prose, ids: [] })
  })
  it('opens candidates at the current token, including Chinese and directory searches', () => {
    expect(completionAt('/comp', 5)).toEqual({ kind: 'commands', start: 0, end: 5, query: 'comp' })
    expect(completionAt('参考 @灯塔 旧事', 9)).toEqual({ kind: 'references', start: 3, end: 9, query: '灯塔 旧事' })
    expect(completionAt('@notes/chapter', 14)?.query).toBe('notes/chapter')
    expect(completionAt('mail@example.com', 16)).toBeNull()
    expect(completionAt('/compact 正文', 11)).toBeNull()
  })
})
