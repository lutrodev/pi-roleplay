import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { attachmentLimits, attachmentSize, isPreviewImage, pasteAttachmentText, transferFiles, validateAttachments } from '../apps/web/src/pages/story/attachment-input.ts'
import { ComposerAttachments } from '../apps/web/src/pages/story/composer-attachments.tsx'
import { CompletionPicker } from '../apps/web/src/pages/story/completion-picker.tsx'
import { composerCommand } from '../apps/web/src/pages/story/composer-commands.ts'
import type { FileRecord } from '../packages/rp-core/src/types.ts'

describe('attachment intake', () => {
  it('accepts exact count/size limits and includes pending uploads in the reservation', () => {
    const { count, fileBytes, totalBytes } = attachmentLimits
    expect(() => validateAttachments([], [{ name: 'one', size: fileBytes }, { name: 'two', size: fileBytes }])).not.toThrow()
    expect(() => validateAttachments([{ size: totalBytes }], [{ name: 'more', size: 1 }])).toThrow('50 MB')
    expect(() => validateAttachments(Array.from({ length: count }, () => ({ size: 1 })), [{ name: 'more', size: 1 }])).toThrow('16')
    expect(() => validateAttachments([], [{ name: 'large', size: fileBytes + 1 }])).toThrow('25 MB')
    expect(() => validateAttachments([], [{ name: 'empty', size: 0 }])).toThrow('为空')
  })
  it('reads clipboard and drop files exactly once, with an items fallback', () => {
    const image = new File(['image'], 'paste.png', { type: 'image/png' }), text = new File(['text'], 'notes.txt', { type: 'text/plain' })
    const items = [{ kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => image }, { kind: 'file', getAsFile: () => text }]
    expect(transferFiles({ files: [image, text], items } as unknown as DataTransfer)).toEqual([image, text])
    expect(transferFiles({ files: [], items } as unknown as DataTransfer)).toEqual([image, text])
  })
  it('preserves text and selection for mixed image/text paste, and bounds Unicode text', () => {
    expect(pasteAttachmentText('请看这里。', '这张图', 2, 4)).toEqual({ text: '请看这张图。', cursor: 5 })
    const result = pasteAttachmentText('文'.repeat(199999), '😀后续', 199999, 199999)
    expect(result.text.endsWith('😀')).toBe(true)
    expect([...result.text]).toHaveLength(200000)
    expect(result.cursor).toBe(200001)
  })
  it('previews only supported raster images and formats sizes without HTML or unsupported SVG', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) expect(isPreviewImage(type)).toBe(true)
    for (const type of ['image/svg+xml', 'text/html', 'application/pdf']) expect(isPreviewImage(type)).toBe(false)
    expect([0, 1536, 1024 * 1024, 1.5 * 1024 * 1024].map(attachmentSize)).toEqual(['0 B', '2 KB', '1 MB', '1.5 MB'])
  })
})

it('renders thumbnails, file cards, cancel/retry controls and explicit upload errors', () => {
  const base = { storageKey: 'storage', size: 2048, sha256: 'sha', createdAt: new Date(0).toISOString() }
  const files: FileRecord[] = [{ ...base, id: 'image', name: '海岸.png', mimeType: 'image/png' }, { ...base, id: 'document', name: '<script>.txt', mimeType: 'text/plain' }]
  const html = renderToStaticMarkup(createElement(ComposerAttachments, { files, uploads: [
    { id: 'pending', file: new File(['data'], '等候.txt'), status: 'uploading' },
    { id: 'failed', file: new File(['data'], '失败.txt'), status: 'error', error: '连接中断' },
  ], disabled: false, remove: () => {}, cancel: () => {}, retry: () => {} }))
  expect(html).toContain('src="/api/files/image/content"')
  expect(html).toContain('预览图片 海岸.png')
  expect(html).toContain('&lt;script&gt;.txt')
  expect(html).not.toContain('<script>')
  expect(html).toContain('移除附件 等候.txt')
  expect(html).toContain('重试上传 失败.txt：连接中断')
  expect(html).toContain('role="alert">失败.txt：连接中断')
})

it('keeps compact as the only built-in command; other text is not a feedback action', () => {
  expect(composerCommand(' /compact \n')).toEqual({ name: 'compact', argument: '' })
  expect(composerCommand('/compact 后续')).toEqual({ name: 'compact', argument: '后续' })
  for (const text of ['/feedback', '/feedback 评论', '/compact-extra', '你好 /compact']) expect(composerCommand(text)).toBeNull()
})

it('renders compact one-line command labels and an attachment entry, without redundant slash icons or feedback', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['skills'], { skills: [{ name: 'story-guide', description: '构思下一幕', enabled: true, userInvocable: true }] })
  const render = (kind: 'commands' | 'references', query = '') => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(CompletionPicker, { kind, query, listId: 'commands', storyId: 'story', agent: true, ref: null, pick: () => {}, browse: () => {}, onActiveChange: () => {}, attach: () => {} })))
  const commands = render('commands')
  expect(commands).toContain('整理总结')
  expect(commands).toContain('story-guide')
  expect(commands).not.toContain('feedback')
  expect(commands).not.toContain('lucide-slash')
  expect(commands).not.toContain('>/compact<')
  expect(commands).toContain('class="sr-only"')
  expect(render('commands', 'comp')).toContain('整理总结')
  expect(render('commands', 'feedback')).toContain('没有匹配的选项')
  expect(render('references')).toContain('文件和图片')
  client.clear()
})
