import { ContentImage } from './content-image.tsx'
import { uiT, uiLocale, useUiLanguage } from "../lib/i18n.ts"
import { useState, type ReactNode } from 'react'
import type { AssetRecord, JsonObject } from '../../../../packages/rp-core/src/types.ts'
import { useAsset } from '../lib/api.ts'
import { ErrorNotice, Field, Input, JsonView, Loading, Select, TabGroup } from './ui.tsx'
import { Markdown } from './markdown.tsx'

const textLabels: Record<string, string> = { description: '描述', personality: '性格', scenario: '场景', firstMessage: '默认开场', messageExample: '消息示例', creatorNotes: '作者备注', content: '写作要求' }
const loreLevels = [{ value: 'worldDescription', label: '世界设定' }, { value: 'roleplayGuide', label: '扮演指导' }, { value: 'importantRules', label: '重要规则' }] as const
function Fold({ label, children, preview }: { label: string; children: ReactNode; preview?: string }) {
  useUiLanguage()
  const [open, setOpen] = useState(false)
  return <details className="asset-detail-section" onToggle={event => setOpen(event.currentTarget.open)}><summary>{label}{!open && preview && <span className="asset-detail-preview">{preview}</span>}</summary>{open && <div className="asset-detail-body">{children}</div>}</details>
}
export function AssetDetailsById({ id, query = '', unavailable }: { id: string; query?: string; unavailable?: ReactNode }) {
  useUiLanguage()
  const source = useAsset(id)
  if (source.isPending) return <Loading />
  if (!source.data) return <div className="stack"><ErrorNotice source="read" error={source.error} retry={() => void source.refetch()} retrying={source.isFetching} />{unavailable}</div>
  return <><AssetDetails asset={source.data.asset} query={query} />{!!source.data.associatedLorebooks.length && <Fold label={uiT("关联世界书 · %{v0} 本", { v0: source.data.associatedLorebooks.length })}>
    {source.data.associatedLorebooks.map(book => <Fold key={book.id} label={book.name}><AssetDetailsById id={book.id} query={query} /></Fold>)}
  </Fold>}</>
}
export function AssetDetails({ asset, query = '' }: { asset: AssetRecord; query?: string }) {
  useUiLanguage()
  const { data, kind } = asset, [search, setSearch] = useState(''), [level, setLevel] = useState<string>('worldDescription'), [status, setStatus] = useState('all')
  const needles = [query, search].map(text => text.trim().toLocaleLowerCase()).filter(Boolean)
  const matches = (text: unknown) => needles.every(needle => asset.name.toLocaleLowerCase().includes(needle) || String(text ?? '').toLocaleLowerCase().includes(needle))
  const entries = (kind === 'preset' ? data.fields : data.entries) as JsonObject[] | undefined
  const quarantined = (data.quarantinedPrompts ?? []) as { path: string; value: string }[], accepted = (data.acceptedPromptPaths ?? []) as string[]
  const visibleEntries = (entries ?? []).filter(entry => matches(`${entry.name}\n${entry.content}\n${(entry.keys as string[] | undefined)?.join(' ') ?? ''}`) && (kind !== 'lorebook' || entry.level === level && (status === 'all' || (entry.enabled !== false) === (status === 'enabled'))))
  const contents = <>{visibleEntries.map(entry => <Fold key={String(entry.id)} label={`${String(entry.name)}${entry.enabled === false ? uiT(" · 已停用") : entry.constant ? uiT(" · 常驻") : ''}`}>
    <Markdown text={String(entry.content ?? '')} />{!!entry.description && <p className="muted">{String(entry.description)}</p>}
    {kind === 'lorebook' ? <dl className="asset-metadata">{[['keys', uiT("关键词")], ['secondaryKeys', uiT("补充关键词")], ['stateCondition', uiT("变量条件")], ['probability', uiT("触发概率")], ['order', uiT("排序")], ['depth', uiT("插入深度")]].map(([key, label]) => entry[key!] !== undefined && <div key={key}><dt>{label}</dt><dd>{Array.isArray(entry[key!]) ? (entry[key!] as string[]).join('、') : String(entry[key!])}</dd></div>)}</dl> : <p className="muted">{entry.position === 'bottom' ? uiT("底部") : uiT("顶部")} · {entry.sectionTag === false ? uiT("不使用分组标签") : uiT("使用分组标签")}</p>}
    <Fold label={uiT("条目完整设置")}><JsonView value={entry} /></Fold>
  </Fold>)}{!visibleEntries.length && <p className="muted">{uiT("这个分类下没有匹配内容。")}</p>}</>
  return <section className="asset-details stack">
    <header className="asset-details-heading">{asset.avatarFileId && <ContentImage className="avatar" src={`/api/files/${asset.avatarFileId}/content`} alt={asset.name} />}<div><h3>{asset.name}</h3><small>{new Date(asset.updatedAt).toLocaleString(uiLocale())}</small></div></header>
    {!!(data.tags as string[] | undefined)?.length && <div className="asset-tags">{(data.tags as string[]).map(tag => <span key={tag}>{tag}</span>)}</div>}
    <dl className="asset-metadata">{[['creator', uiT("作者")], ['characterVersion', uiT("角色版本")], ['nickname', uiT("别名")]].map(([key, label]) => data[key!] && <div key={key}><dt>{label}</dt><dd>{String(data[key!])}</dd></div>)}</dl>
    {Object.entries(textLabels).filter(([key]) => typeof data[key] === 'string' && data[key] && matches(`${uiT(textLabels[key]!)}\n${data[key]}`)).map(([key, label]) => String(data[key]).length <= 280
      ? <section className="asset-detail-text" key={key}><h4>{uiT(label)}</h4><Markdown text={String(data[key])} /></section>
      : <Fold key={key} label={uiT("%{v0} · %{v1} 字", { v0: uiT(label), v1: [...String(data[key])].length.toLocaleString(uiLocale()) })} preview={String(data[key]).slice(0, 160)}><Markdown text={String(data[key])} /></Fold>)}
    {(['alternateGreetings', 'groupOnlyGreetings'] as const).flatMap(key => ((data[key] ?? []) as string[]).map((text, index) => matches(text) && <Fold key={`${key}-${index}`} label={key === 'alternateGreetings' ? uiT("开场 %{v0}", { v0: index + 2 }) : uiT("群聊开场 %{v0}", { v0: index + 1 })}><Markdown text={text} /></Fold>))}
    {entries && <div className="stack"><Field label={uiT("搜索资料内容")}><Input value={search} onChange={event => setSearch(event.target.value)} placeholder={uiT("条目名称、关键词或正文")} /></Field>
      {kind === 'lorebook' ? <><Field label={uiT("内容状态")}><Select value={status} onChange={event => setStatus(event.target.value)}><option value="all">{uiT("全部状态")}</option><option value="enabled">{uiT("已启用")}</option><option value="disabled">{uiT("已停用")}</option></Select></Field><TabGroup label={uiT("世界书内容分类")} value={level} onChange={setLevel} items={loreLevels.map(item => ({ ...item, label: `${uiT(item.label)} · ${entries.filter(entry => entry.level === item.value).length}` }))}>{contents}</TabGroup></> : contents}
    </div>}
    {quarantined.length > 0 && <Fold label={uiT("附加提示 · %{v0} 项", { v0: quarantined.length })}><p className="muted">{uiT("仅明确启用的项目会进入生成；可在资料库编辑中调整。")}</p>{quarantined.map(item => <Fold key={item.path} label={`${item.path} · ${accepted.includes(item.path) ? uiT("已启用") : uiT("未启用")}`}><pre className="prompt-preview">{item.value}</pre></Fold>)}</Fold>}
    {data.characterBook && <Fold label={uiT("角色卡内世界书（只读）")}><JsonView value={data.characterBook} /></Fold>}
    {data.extensions && Object.keys(data.extensions).length > 0 && <Fold label={uiT("附加数据（只读）")}><JsonView value={data.extensions} /></Fold>}
    {data.sourcePayload && <Fold label={uiT("导入信息与保留原文（只读）")}><JsonView value={data.sourcePayload} /></Fold>}
  </section>
}
