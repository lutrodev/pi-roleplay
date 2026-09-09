import { ContentImage } from '../../components/content-image.tsx'
import { useLayoutEffect, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { BookOpen, ChevronRight, Feather, Search, Users } from 'lucide-react'
import type { AssetRecord, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import { api, type AssetItem } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { assetLabels } from '../../components/selectors.tsx'
import { Empty, Input, Loading, TabGroup } from '../../components/ui.tsx'
import { MaterialReader } from './material-reader.tsx'
import { materialExcerpt, materialGroups, materialMatches, materialReferences } from './material-content.ts'

const groupIcons = { people: Users, world: BookOpen, writing: Feather }
export function StoryWiki({ story }: { story: StorySnapshot }) {
  useUiLanguage()
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<string | null>(null), [category, setCategory] = useState<(typeof materialGroups)[number]['id']>('people')
  const root = useRef<HTMLDivElement>(null), origin = useRef(''), scroll = useRef(0), previous = useRef(selected)
  const refs = materialReferences(story.profile)
  const sources = useQueries({ queries: refs.map(ref => ({ queryKey: ['asset', ref.id], queryFn: ({ signal }: { signal: AbortSignal }) => api<{ asset: AssetRecord; associatedLorebooks: AssetItem[] }>(`/assets/${encodeURIComponent(ref.id)}`, 'GET', undefined, signal) })) })
  const items = refs.map((ref, index) => ({ ...ref, source: sources[index]! }))
  const active = items.find(item => item.id === selected)
  useLayoutEffect(() => {
    if (previous.current === selected) return
    const body = root.current?.closest('.inspector-body')
    if (body) body.scrollTop = selected ? 0 : scroll.current
    if (selected) root.current?.querySelector<HTMLElement>('[data-reader-heading]')?.focus({ preventScroll: true })
    else root.current?.querySelector<HTMLElement>(`[data-material-id="${CSS.escape(origin.current)}"]`)?.focus({ preventScroll: true })
    previous.current = selected
  }, [selected])
  const open = (id: string) => {
    origin.current = id; scroll.current = root.current?.closest('.inspector-body')?.scrollTop ?? 0; setSelected(id)
  }
  const filtered = items.filter(item => !item.source.data || materialMatches(item.source.data.asset, query))
  const groups = materialGroups.filter(group => query.trim() || group.id === category).map(group => {
    const matching = filtered.filter(item => (group.kinds as readonly string[]).includes(item.kind)), Icon = groupIcons[group.id]
    if (query.trim() && !matching.length) return null
    return <section className={`material-group material-group-${group.id}`} key={group.id} aria-labelledby={`material-group-${group.id}`}>
      <header><h3 id={`material-group-${group.id}`}>{query.trim() && <Icon size={16} />}{uiT(query.trim() ? group.label : group.description)}</h3></header>
      <div className="material-group-items">{matching.map(item => {
        const asset = item.source.data?.asset
        return <button type="button" key={item.id} data-material-id={item.id} className="material-card" aria-label={uiT('阅读%{kind}：%{name}', { kind: uiT(assetLabels[item.kind]), name: asset?.name ?? uiT('暂时无法读取') })} onClick={() => open(item.id)}>
          <span className="material-card-top"><span className="material-kind">{uiT(assetLabels[item.kind])}</span><ChevronRight size={15} /></span>
          {item.source.isPending ? <Loading /> : <><span className="material-card-title">{asset?.avatarFileId && <ContentImage src={`/api/files/${asset.avatarFileId}/content`} alt="" />}<strong>{asset?.name ?? uiT('暂时无法读取')}</strong></span><span className="material-excerpt">{asset ? materialExcerpt(asset, query) || uiT('暂无文字介绍') : uiT('资料可能已移除，点此查看详情。')}</span></>}
        </button>
      })}</div>
      {!query.trim() && group.kinds.filter(kind => !items.some(item => item.kind === kind)).map(kind => <p className="material-unbound" key={kind}><span>{uiT(assetLabels[kind])}</span>{uiT('未使用')}</p>)}
    </section>
  })
  return <div className="story-materials" ref={root}>
    {active ? <MaterialReader key={active.id} storyId={story.id} asset={active.source.data?.asset} kind={active.kind} pending={active.source.isPending} error={active.source.error} retry={() => void active.source.refetch()} query={query} back={() => setSelected(null)} /> : <>
      <header className="inspector-intro"><h3>{uiT('这段故事的设定')}</h3><p>{uiT('人物、世界与写作方式，一览即可了解。')}</p></header>
      <div className="search-field material-search"><Search size={16} /><Input aria-label={uiT('搜索会话资料')} value={query} onChange={event => setQuery(event.target.value)} placeholder={uiT('搜索已引用的资料…')} /></div>
      {query.trim() && <p className="material-search-status" role="status">{uiT('找到 %{count} 份资料', { count: filtered.filter(item => item.source.data).length })}</p>}
      {query.trim() ? <div className="material-results">{groups}</div> : <TabGroup className="material-categories" label={uiT('资料类型')} value={category} onChange={setCategory} items={materialGroups.map(group => { const Icon = groupIcons[group.id]; return { value: group.id, icon: <Icon size={16} />, label: `${uiT(group.label)} · ${items.filter(item => (group.kinds as readonly string[]).includes(item.kind)).length}` } })}>{groups}</TabGroup>}
      {query.trim() && !filtered.length && <Empty title={uiT('没有找到相关资料')}>{uiT('试试角色名、条目关键词或正文中的文字。')}</Empty>}
      <footer className="material-footnote"><p>{uiT('这里展示当前引用，内容随资料库同步。')}</p><p>{uiT('打开资料后，可直接前往资料库编辑。')}</p></footer>
    </>}
  </div>
}
