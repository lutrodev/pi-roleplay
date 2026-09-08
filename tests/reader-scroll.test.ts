import { describe, expect, it } from 'vitest'
import { followsReadingScroll } from '../apps/web/src/pages/story/reader-scroll.ts'

describe('following the conversation tail', () => {
  const bottom = { top: 700, height: 1000, viewport: 300 }

  it('keeps following when streamed prose increases the distance to the end', () => {
    expect(followsReadingScroll(bottom, { ...bottom, height: 1300 }, true)).toBe(true)
    expect(followsReadingScroll(bottom, { ...bottom, height: 1500, top: 850 }, true)).toBe(true)
  })

  it('does not treat a resized input area or replaced preview as upward reading', () => {
    expect(followsReadingScroll(bottom, { top: 500, height: 1300, viewport: 500 }, true)).toBe(true)
    expect(followsReadingScroll(bottom, { top: 400, height: 900, viewport: 300 }, true)).toBe(true)
  })

  it('pauses when the reader scrolls upward, including during prose growth', () => {
    expect(followsReadingScroll(bottom, { ...bottom, top: 500 }, true)).toBe(false)
    expect(followsReadingScroll(bottom, { ...bottom, top: 500, height: 1300 }, true)).toBe(false)
  })

  it('preserves a paused reading position until the reader returns to the end', () => {
    const paused = { ...bottom, top: 300 }
    expect(followsReadingScroll(paused, { ...paused, height: 1500 }, false)).toBe(false)
    expect(followsReadingScroll(paused, { ...paused, top: 500 }, false)).toBe(false)
    expect(followsReadingScroll(paused, bottom, false)).toBe(true)
  })
})
