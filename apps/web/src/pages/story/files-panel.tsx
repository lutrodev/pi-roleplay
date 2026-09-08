import { StatusNotice } from '../../components/status-notice.tsx'

import { useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ChevronRight, Download, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import { api } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { ErrorNotice, Button, Empty, Field, IconButton, Input, Loading } from '../../components/ui.tsx'

type FilePreview = { text: string; startLine: number; truncated: boolean; note?: string }
export function FilesPanel({ storyId }: { storyId: string }) {
  useUiLanguage()
  const [path, setPath] = useState('.'), [selected, setSelected] = useState<string | null>(null), [offsets, setOffsets] = useState([1])
  const root = useRef<HTMLDivElement>(null), returning = useRef<string | null>(null), heading = useRef<HTMLHeadingElement>(null)
  const offset = offsets.at(-1)!
  const listing = useQuery({ queryKey: ['workspace', storyId, path], queryFn: ({ signal }) => api<{ entries: { name: string; kind: string }[]; truncated: boolean }>(`/stories/${storyId}/files?path=${encodeURIComponent(path)}`, 'GET', undefined, signal) })
  const preview = useQuery({ queryKey: ['workspace-preview', storyId, selected, offset], enabled: !!selected, queryFn: ({ signal }) => api<FilePreview>(`/stories/${storyId}/files/preview?path=${encodeURIComponent(selected!)}&offset=${offset}&limit=200`, 'GET', undefined, signal) })
  useLayoutEffect(() => {
    const body = root.current?.closest('.inspector-body')
    if (body) body.scrollTop = 0
    if (selected) heading.current?.focus({ preventScroll: true })
  }, [selected, path])
  useLayoutEffect(() => {
    if (selected || !returning.current) return
    const button = root.current?.querySelector<HTMLButtonElement>(`[data-file-name="${CSS.escape(returning.current)}"]`)
    if (button) { button.focus({ preventScroll: true }); button.scrollIntoView({ block: 'nearest' }); returning.current = null }
  }, [selected, listing.data])
  const entries = listing.data?.entries.toSorted((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
  const lineCount = preview.data?.text ? preview.data.text.split('\n').length : 0
  const up = () => { returning.current = path.split('/').at(-1)!; setPath(path.split('/').slice(0, -1).join('/') || '.') }
  const page = (next: number[]) => { setOffsets(next); const body = root.current?.closest('.inspector-body'); if (body) body.scrollTop = 0; heading.current?.focus({ preventScroll: true }) }
  return <div ref={root} className="files-reader">
    {selected ? <>
      <Button tone="quiet" className="material-back" onClick={() => { returning.current = selected.split('/').at(-1)!; setSelected(null) }}><ArrowLeft size={16} />{uiT('文件列表')}</Button>
      <header className="file-reader-heading"><FileText size={21} /><h3 ref={heading} tabIndex={-1}>{selected.split('/').at(-1)}</h3><a className="button button-quiet icon-button" aria-label={uiT('下载文件')} title={uiT('下载文件')} href={`/api/stories/${storyId}/files/download?path=${encodeURIComponent(selected)}`}><Download size={16} /></a></header>
      {path !== '.' && <p className="file-path muted">{path}</p>}
      <ErrorNotice error={preview.error} retry={() => void preview.refetch()} retrying={preview.isFetching} />{preview.isPending && <Loading />}
      {preview.data && <>{lineCount > 0 ? <><p className="material-footnote">{uiT('第 %{start}–%{end} 行', { start: offset, end: offset + lineCount - 1 })}</p><pre className="file-preview">{preview.data.text}</pre></> : <StatusNotice compact title={uiT(offset === 1 ? '文件为空' : '这一行之后没有内容')} actions={offset > 1 ? <Button onClick={() => page([1])}>{uiT('回到文件开头')}</Button> : undefined} />}{preview.data.note && <p className="material-footnote">{preview.data.note}</p>}{(preview.data.truncated || offsets.length > 1) && <nav className="file-pagination" aria-label={uiT('文件内容翻页')}><Button tone="quiet" disabled={offsets.length === 1} onClick={() => page(offsets.slice(0, -1))}>{uiT('上一段')}</Button><Button tone="quiet" disabled={!preview.data.truncated} onClick={() => page([...offsets, offset + Math.max(1, lineCount - 1)])}>{uiT('下一段')}</Button></nav>}</>}
      <details className="context-section"><summary>{uiT('按行定位')}</summary><Field label={uiT('从第几行开始预览')}><Input type="number" min={1} value={offset} onChange={event => setOffsets([Math.max(1, Number(event.target.value))])} /></Field></details>
    </> : <>
      <header className="inspector-intro"><h3>{uiT('故事里的文件')}</h3><p>{uiT('浏览 Agent 留下的文档，点开即可阅读。')}</p></header>
      <nav className="file-location" aria-label={uiT('当前目录')}>{path !== '.' && <IconButton label={uiT('返回上层目录')} onClick={up}><ArrowLeft size={16} /></IconButton>}<FolderOpen size={16} /><span className="file-path">{path === '.' ? uiT('会话工作目录') : path}</span><IconButton label={uiT('刷新文件列表')} onClick={() => void listing.refetch()}><RefreshCw size={15} /></IconButton></nav>
      <ErrorNotice error={listing.error} retry={() => void listing.refetch()} retrying={listing.isFetching} />{listing.isPending && <Loading />}
      <ul className="file-reading-list">{entries?.map(entry => <li key={entry.name}><button type="button" data-file-name={entry.name} onClick={() => { const next = path === '.' ? entry.name : `${path}/${entry.name}`; if (entry.kind === 'directory') setPath(next); else { setSelected(next); setOffsets([1]) } }}>{entry.kind === 'directory' ? <Folder size={19} /> : <FileText size={19} />}<span><strong>{entry.name}</strong><small>{uiT(entry.kind === 'directory' ? '文件夹' : entry.kind === 'symlink' ? '链接' : '文件')}</small></span><ChevronRight size={15} /></button></li>)}</ul>
      {!listing.error && entries?.length === 0 && <Empty icon={<FolderOpen size={25} />} title={uiT(path === '.' ? '还没有会话文件' : '这个文件夹是空的')}>{uiT('Agent 创建的文件会出现在这里。')}</Empty>}
      {listing.data?.truncated && <p className="notice">{uiT('当前目录条目超过显示上限，请打开子目录查看。')}</p>}
    </>}
  </div>
}
