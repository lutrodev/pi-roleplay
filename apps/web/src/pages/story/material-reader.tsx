import { ContentImage } from '../../components/content-image.tsx'
import { useState, type ReactNode } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import type { AssetKind, AssetRecord, JsonObject } from '../../../../../packages/rp-core/src/types.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { assetLabels } from '../../components/selectors.tsx'
import { Button, Empty, ErrorNotice, Input, Loading } from '../../components/ui.tsx'
import { Markdown } from '../../components/markdown.tsx'
import { entrySearchText, materialEntries, materialSections } from './material-content.ts'

const levels = [{ id: 'worldDescription', label: '世界设定' }, { id: 'roleplayGuide', label: '扮演指导' }, { id: 'importantRules', label: '重要规则' }]
function ReadingFold({ title, text, children, expanded = false, search = '', badge }: { title: string; text: string; children?: ReactNode; expanded?: boolean; search?: string; badge?: string }) {
  const [open, setOpen] = useState(expanded)
  return <details className="material-fold" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><span className="material-fold-label"><strong>{title}</strong>{badge && <small>{badge}</small>}</span>{!open && <span className="material-excerpt">{text.slice(0, 160)}</span>}</summary>{open && <div className="material-fold-body"><Markdown text={text} search={search} />{children}</div>}</details>
}
export function MaterialReader({ asset, kind, pending, error, retry, query, back }: {
  asset?: AssetRecord; kind: AssetKind; pending: boolean; error: Error | null; retry: () => void; query: string; back: () => void
}) {
  useUiLanguage()
  const [search, setSearch] = useState(query), needle = search.trim().toLocaleLowerCase()
  const nameMatches = !!needle && !!asset?.name.toLocaleLowerCase().includes(needle)
  const matches = (text: string) => !needle || nameMatches || text.toLocaleLowerCase().includes(needle)
  const sections = asset ? materialSections(asset).filter(section => matches(`${uiT(section.label)}\n${section.text}`)) : []
  const entries = asset ? materialEntries(asset).filter(entry => matches(entrySearchText(entry))) : []
  const groups = kind === 'lorebook' ? levels.map(level => ({ ...level, entries: entries.filter(entry => entry.level === level.id) })) : [{ id: 'preset', label: '创作指引', entries }]
  return <article className="material-reader">
    <div className="material-reader-bar"><Button tone="quiet" className="material-back" onClick={back}><ArrowLeft size={16} />{uiT('资料总览')}</Button></div>
    <header className="material-reader-heading">{asset?.avatarFileId && <ContentImage src={`/api/files/${asset.avatarFileId}/content`} alt="" />}<div><span className="material-kind">{uiT(assetLabels[kind])}</span><h3 tabIndex={-1} data-reader-heading>{asset?.name ?? uiT('资料详情')}</h3></div></header>
    <ErrorNotice source="read" error={error} retry={retry} />{pending && <Loading />}
    {asset && <>
      {!!(asset.data.tags as string[] | undefined)?.length && <div className="asset-tags">{(asset.data.tags as string[]).map(tag => <span key={tag}>{tag}</span>)}</div>}
      <div className="search-field material-search"><Search size={16} /><Input aria-label={uiT('搜索这份资料')} value={search} onChange={event => setSearch(event.target.value)} placeholder={uiT('搜索这份资料…')} /></div>
      {kind === 'lorebook' && <p className="material-footnote">{uiT('条目按关键词或条件参与回复；是否命中以当轮上下文为准。')}</p>}
      {sections.map(section => section.secondary || section.text.length > 600
        ? <ReadingFold key={`${section.id}-${needle}`} title={uiT(section.label)} text={section.text} search={search} expanded={!!needle && !nameMatches} />
        : <section key={section.id} className="material-text"><h4>{uiT(section.label)}</h4><Markdown text={section.text} search={search} /></section>)}
      {groups.filter(group => group.entries.length).map(group => <section className="material-entry-group" key={group.id}><h4>{uiT(group.label)}<small>{group.entries.length}</small></h4>{group.entries.map((entry, index) => <ReadingFold key={`${String(entry.id ?? index)}-${needle}`} title={String(entry.name || uiT('未命名条目'))} text={String(entry.content ?? '')} search={search} expanded={!!needle && !nameMatches} badge={entry.enabled === false ? uiT('已停用') : kind === 'lorebook' ? entry.constant ? uiT('常驻') : uiT('按条件匹配') : undefined}><EntryNotes entry={entry} kind={kind} /></ReadingFold>)}</section>)}
      {!sections.length && !entries.length && <Empty title={uiT(needle ? '没有找到相关内容' : '这份资料还没有正文')} />}
      <footer className="material-footnote">{uiT('资料修改、导入原文和高级设置，请在资料库中查看。')}</footer>
    </>}
  </article>
}
function EntryNotes({ entry, kind }: { entry: JsonObject; kind: AssetKind }) {
  const keys = Array.isArray(entry.keys) ? entry.keys.filter(key => typeof key === 'string') : [], secondary = Array.isArray(entry.secondaryKeys) ? entry.secondaryKeys.filter(key => typeof key === 'string') : []
  return <>{!!entry.description && <p className="material-footnote">{String(entry.description)}</p>}{kind === 'lorebook' && (keys.length > 0 || secondary.length > 0 || !!entry.stateCondition) && <dl className="material-entry-notes">{keys.length > 0 && <div><dt>{uiT('关键词')}</dt><dd>{keys.join('、')}</dd></div>}{secondary.length > 0 && <div><dt>{uiT('补充关键词')}</dt><dd>{secondary.join('、')}</dd></div>}{!!entry.stateCondition && <div><dt>{uiT('变量条件')}</dt><dd>{String(entry.stateCondition)}</dd></div>}</dl>}</>
}
