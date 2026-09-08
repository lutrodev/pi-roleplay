import assert from 'node:assert/strict'
import test from 'node:test'
import { dialogueBoundary, findDialogueRanges } from '../../src/display/dialogue-ranges.js'
import { highlightSlices } from '../../src/display/dom-highlight.js'

function selected(text) {
  return findDialogueRanges(text).map(range => text.slice(range.start, range.end))
}

test('locates the supported Chinese and straight quote pairs', () => {
  const text = '她说：“留下。” 又补充「别回头」。最后是 "okay"。'
  assert.deepEqual(selected(text), ['“留下。”', '「别回头」', '"okay"'])
})

test('keeps nested quotation ranges and spans line breaks', () => {
  const text = '“她问：‘现在走吗？’\n我点了头。”'
  assert.deepEqual(selected(text), [text, '‘现在走吗？’'])
})

test('ignores unmatched quotes and never pairs across excluded content', () => {
  assert.deepEqual(selected('前文“没有结束'), [])
  assert.deepEqual(selected(`“正文${dialogueBoundary}代码”`), [])
})

test('temporarily extends unclosed quotes to the streaming text end', () => {
  const text = '前文“她问：‘现在走吗'
  const ranges = findDialogueRanges(text, { includeUnclosed: true })
  assert.deepEqual(ranges.map(range => text.slice(range.start, range.end)), [
    '“她问：‘现在走吗',
    '‘现在走吗',
  ])
  assert.deepEqual(findDialogueRanges(`“正文${dialogueBoundary}代码`, { includeUnclosed: true }), [])
})

test('treats repeated straight quotes as independent pairs', () => {
  const text = '她说"一"，又说"二"。'
  assert.deepEqual(selected(text), ['"一"', '"二"'])
})

test('partitions clone text nodes against nested and cross-node ranges', () => {
  assert.deepEqual(highlightSlices(4, 12, [
    { start: 1, end: 7 },
    { start: 6, end: 10 },
    { start: 11, end: 20 },
  ]), [
    { start: 4, end: 10, highlighted: true },
    { start: 10, end: 11, highlighted: false },
    { start: 11, end: 12, highlighted: true },
  ])
})

