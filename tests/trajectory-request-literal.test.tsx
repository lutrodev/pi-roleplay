import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { RequestMessages } from '../apps/web/src/pages/story/trajectory/history.tsx'

it('shows exact request text, XML boundaries and native roles without interpreting Markdown or HTML', () => {
  const text = '<section name="资料">\n<item name="说明">\n**原文**\n<script>literal-only</script>\n</item>\n</section>'
  const html = renderToStaticMarkup(<RequestMessages input={{ messages: [
    { role: 'user', content: [{ type: 'text', text }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'note.md' } }] },
    { role: 'toolResult', toolCallId: 'call', toolName: 'read', isError: true, content: [{ type: 'text', text: '<error>保留标签</error>' }] },
  ] }} />)
  expect(html).toContain('&lt;section name=&quot;资料&quot;&gt;')
  expect(html).toContain('&lt;/section&gt;')
  expect(html).toContain('&lt;item name=&quot;说明&quot;&gt;')
  expect(html).toContain('**原文**')
  expect(html).toContain('&lt;script&gt;literal-only&lt;/script&gt;')
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;error&gt;保留标签&lt;/error&gt;')
  expect(html).toContain('用户'); expect(html).toContain('助手'); expect(html).toContain('工具结果')
})
