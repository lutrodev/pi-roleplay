import { ContentImage } from './content-image.tsx'
import { uiT } from "../lib/i18n.ts"
import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { dialoguePlugin } from '../lib/dialogue-plugin.ts'
import { cjkEmphasisPlugin } from '../lib/cjk-emphasis-plugin.ts'
import { searchPlugin } from '../lib/search-plugin.ts'
export const Markdown = memo(function Markdown({ text, highlight = false, search = '' }: { text: string; highlight?: boolean; search?: string }) {
  return <div className="prose"><ReactMarkdown remarkPlugins={highlight ? [remarkGfm, cjkEmphasisPlugin, dialoguePlugin] : [remarkGfm, cjkEmphasisPlugin]} rehypePlugins={search ? [[searchPlugin, { query: search }]] : []} skipHtml components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ src, alt }) => typeof src === 'string' && src.startsWith('/api/files/') ? <ContentImage src={src} alt={alt ?? ''} loading="lazy" /> : typeof src === 'string' ? <a href={src} target="_blank" rel="noopener noreferrer">{uiT("查看图片：")}{alt || uiT("外部图片")}</a> : null,
  }}>{text}</ReactMarkdown></div>
})
