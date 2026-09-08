import { ContentImage } from '../../../components/content-image.tsx'
import { createContext, useContext, type ReactNode } from 'react'
import { Markdown } from '../../../components/markdown.tsx'
import { uiT } from '../../../lib/i18n.ts'
import { Highlight } from './ledger.tsx'

export const TraceSearch = createContext('')
export function TraceText({ text, className = 'trajectory-literal' }: { text: string; className?: string }) {
  return <pre className={className}><Highlight text={text} search={useContext(TraceSearch)} /></pre>
}
export function TraceJson({ value }: { value: unknown }) { return <TraceText className="json-view" text={JSON.stringify(value, null, 2) ?? uiT('未记录')} /> }

export const asObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const asText = (value: unknown) => typeof value === 'string' ? value : ''

function ImageReference({ value }: { value: Record<string, unknown> }) {
  return typeof value.fileId === 'string' ? <a className="trajectory-image" href={`/api/files/${encodeURIComponent(value.fileId)}/content`} target="_blank" rel="noopener noreferrer"><ContentImage src={`/api/files/${encodeURIComponent(value.fileId)}/content`} alt={uiT('请求中的图片')} loading="lazy" /></a> : <p className="muted">{uiT('图片引用未记录')}</p>
}
export function Blocks({ value, literal = false }: { value: unknown; literal?: boolean }) {
  const search = useContext(TraceSearch)
  if (typeof value === 'string') return literal ? <TraceText text={value} /> : <Markdown text={value} search={search} />
  if (!Array.isArray(value)) return value == null ? <p className="muted">{uiT('未记录')}</p> : <TraceJson value={value} />
  if (!value.length) return <p className="muted">{uiT('没有文本内容')}</p>
  return <>{value.map((part, index) => {
    const block = asObject(part)
    if (block.type === 'text') return literal ? <TraceText key={index} text={asText(block.text)} /> : <Markdown key={index} text={asText(block.text)} search={search} />
    if (block.type === 'thinking') return <section className="trajectory-thinking" key={index}><small>{uiT('思考')}</small>{literal ? <TraceText text={asText(block.thinking)} /> : <Markdown text={asText(block.thinking)} search={search} />}</section>
    if (block.type === 'image_reference') return <ImageReference key={index} value={block} />
    if (block.type === 'toolCall') return <section className="trajectory-content-section" key={index}><h4>{uiT('工具调用')} · {asText(block.name)}</h4><Fields value={block.arguments} /></section>
    return <TraceJson key={index} value={block} />
  })}</>
}
/** Typed message content remains literal data; only the UI role labels are translated. */
export function Messages({ value, literal = false }: { value: unknown; literal?: boolean }) {
  if (!Array.isArray(value)) return <Blocks value={value} literal={literal} />
  const labels: Record<string, string> = { user: '用户', assistant: '助手', system: '系统', toolResult: '工具结果' }
  return <>{value.map((item, index) => {
    const message = asObject(item), role = asText(message.role)
    return <section className="trajectory-message" key={index}><header><span className="trajectory-role" data-kind={role === 'toolResult' ? 'tool' : role}>{uiT(labels[role] ?? role)}</span>{typeof message.toolName === 'string' && <code>{message.toolName}</code>}<small>#{index + 1}</small></header><Blocks value={message.content} literal={literal} /></section>
  })}</>
}
export function Fields({ value }: { value: unknown }) {
  const fields = Object.entries(asObject(value))
  if (!fields.length) return <Blocks value={value} />
  return <dl className="trajectory-fields">{fields.map(([key, item]) => <div key={key}><dt>{key}</dt><dd>{typeof item === 'string' ? <TraceText text={item} /> : <TraceJson value={item} />}</dd></div>)}</dl>
}
export function ResultContent({ value }: { value: unknown }) {
  const result = asObject(value), details = asObject(result.details)
  const blocks = Array.isArray(result.content) ? result.content : undefined
  const shown = new Set<string>()
  const rendered = blocks?.map((item, index) => {
    const block = asObject(item)
    if (block.type === 'text' && typeof block.text === 'string') {
      try {
        const parsed = asObject(JSON.parse(block.text))
        if (Object.keys(parsed).length) {
          for (const [key, value] of Object.entries(parsed)) if (JSON.stringify(value) === JSON.stringify(details[key])) shown.add(key)
          const { text, ...fields } = parsed
          return <section key={index}>{typeof text === 'string' && <Blocks value={text} />}{Object.keys(fields).length > 0 && <Fields value={fields} />}</section>
        }
      } catch { /* Plain text remains readable Markdown. */ }
    }
    if (block.type === 'text' && block.text === details.text) shown.add('text')
    return <Blocks key={index} value={[item]} />
  })
  const remaining = Object.fromEntries(Object.entries(details).filter(([key]) => !shown.has(key)))
  return <>{rendered}{Object.keys(remaining).length > 0 && <section className="trajectory-content-section"><h4>{uiT('结果字段')}</h4><Fields value={remaining} /></section>}{!blocks && <Fields value={value} />}</>
}
export function ContentSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="trajectory-content-section"><h4>{uiT(title)}</h4>{children}</section>
}
