import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../apps/web/src/components/markdown.tsx'

const render = (text: string, highlight = false, search = '') => renderToStaticMarkup(createElement(Markdown, { text, highlight, search }))

describe('CJK single-star emphasis in rendered prose', () => {
  it.each([
    ['*灯塔...还亮着。 *她在心底无声地说。', '<em>灯塔...还亮着。 </em>她在心底无声地说。'],
    ['*灯塔还亮着。*她望向远处。', '<em>灯塔还亮着。</em>她望向远处。'],
    ['*她**终于**松了口气。 *然后转身。', '<em>她<strong>终于</strong>松了口气。 </em>然后转身。'],
    ['先*等等。 *再*出发！*天快黑了。', '先<em>等等。 </em>再<em>出发！</em>天快黑了。'],
    ['*灯塔亮了！　*她挥了挥手。', '<em>灯塔亮了！　</em>她挥了挥手。'],
    ['*灯塔亮了！\t*她挥了挥手。', '<em>灯塔亮了！\t</em>她挥了挥手。'],
    ['> *门开了。 *她抬起头。\n> *灯亮了。 *她走进去。', '<em>门开了。 </em>她抬起头。\n<em>灯亮了。 </em>她走进去。'],
    ['> *门开了。 *她抬起头。', '<blockquote>\n<p><em>门开了。 </em>她抬起头。</p>'],
    ['- *门开了。 *她抬起头。', '<li><em>门开了。 </em>她抬起头。</li>'],
    ['| 心声 |\n| --- |\n| *门开了。 *她抬起头。 |', '<td><em>门开了。 </em>她抬起头。</td>'],
    ['**她想：*该回去了。 *随后起身。**', '<strong>她想：<em>该回去了。 </em>随后起身。</strong>'],
  ])('renders %s as italics without retaining delimiter stars', (text, expected) => {
    expect(render(text)).toContain(expected)
  })

  it('keeps standard emphasis, bold and nesting intact', () => {
    expect(render('*标准斜体* **标准粗体** ***同时强调*** _italic_')).toContain('<em>标准斜体</em> <strong>标准粗体</strong> <em><strong>同时强调</strong></em> <em>italic</em>')
  })

  it.each([
    '*灯塔未闭合。',
    '* 中文 *',
    '*not italic. *after',
    '计算：2 * 3 * 4',
    '前文 *未结束\n换行后。 *然后离开。',
    '*前一段\n\n后一段。 *',
    '前文 *含有`代码`的段落。 *后文',
    '前文 *含有[链接](https://example.com)的段落。 *后文',
    '[*链接文字。 *](https://example.com/*path*)',
    '前文 *含有<span>标签</span>的段落。 *后文',
    '![*替代文字。 *](https://example.com/image.png)',
    '`*中文代码。 *`\n\n```text\n*中文代码。 *\n```',
    '\\*转义星号。 \\*',
    '&ast;实体星号。 &#42;',
    '&#x2a;实体星号。 &ast;',
    '**未闭合粗体。 **后文',
  ])('does not reinterpret non-prose or ambiguous delimiters: %s', text => {
    expect(render(text)).not.toContain('<em>')
  })

  it('distinguishes escaped and entity stars even when mixed with repairable emphasis', () => {
    expect(render('\\*保留\\* &ast;原样&#42; *终于到了。 *她说。')).toContain('*保留* *原样* <em>终于到了。 </em>她说。')
    expect(render('转义反斜线：\\\\*终于到了。 *她说。')).toContain('转义反斜线：\\<em>终于到了。 </em>她说。')
    expect(render('*她写下 &amp; 和 \\*。 *然后合上笔记。')).toContain('<em>她写下 &amp; 和 *。 </em>然后合上笔记。')
  })

  it('combines repaired emphasis with dialogue and literal search highlights', () => {
    const text = '*“灯塔还亮着。” *她在心里想着。'
    expect(render(text, true)).toContain('<em><span class="dialogue">“灯塔还亮着。”</span> </em>')
    expect(render(text, false)).toContain('<em>“灯塔还亮着。” </em>')
    expect(render(text, true, '灯塔')).toMatch(/<em><span class="dialogue">“<mark[^>]*>灯塔<\/mark>还亮着。”<\/span> <\/em>/)
    expect(text).toBe('*“灯塔还亮着。” *她在心里想着。')
  })
})
