import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Search } from 'lucide-react'
import type { Preferences } from '../../../../../packages/rp-core/src/settings/preferences.ts'
import { SettingsGroup } from '../../components/settings-layout.tsx'
import { SettingToggle } from '../../components/settings-controls.tsx'
import { Button, Empty, ErrorNotice, Input, JsonView, Loading } from '../../components/ui.tsx'
import { api } from '../../lib/api.ts'
import { uiT } from '../../lib/i18n.ts'

export function SkillSettings({ value, onChange }: { value: Preferences; onChange: (next: Partial<Preferences>) => void }) {
  const [search, setSearch] = useState('')
  const query = useQuery({ queryKey: ['skills'], queryFn: () => api<{ skills: { name: string; description: string; content: string; enabled: boolean; modelInvocable: boolean; userInvocable: boolean }[]; diagnostics: unknown[] }>('/settings/skills') })
  return <><SettingsGroup><SettingToggle label={uiT('允许 Agent 使用 Skills')} checked={value.skills} onChange={event => onChange({ skills: event.target.checked })} /></SettingsGroup>
    <details className="settings-explanation"><summary>{uiT('使用与可见范围')}</summary><div className="stack"><p className="muted">{uiT('内置 RP 指导随应用提供。自定义指导放在 VPS 的 Skills 目录中，模型可按需读取；在输入中使用 /指导名称（例如 /rp-guide-state）可以明确指定。')}</p><p className="muted">{uiT('可见范围：Agent 主模型看到已启用的目录；允许 Skills 的任务子代理看到同一轮目录，各自独立加载。Chat 和 Writer 不接收 Skills 目录或父模型加载记录。用户可调用的指导支持 /名称；仅用户可调用的指导不会出现在模型可调用目录中。')}</p></div></details>
    <ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />{query.isPending && <Loading />}
    {query.data && <><div className="search-field"><Search size={16} /><Input aria-label={uiT('搜索 Skills')} placeholder={uiT('按名称或用途搜索')} value={search} onChange={event => setSearch(event.target.value)} /></div><SettingsGroup>{query.data.skills.filter(skill => (skill.name + skill.description).toLowerCase().includes(search.toLowerCase())).map(skill => <section className="skill-row" key={skill.name}><SettingToggle label={skill.name} help={skill.description} checked={!value.disabledSkills.includes(skill.name)} disabled={!value.skills} onChange={event => onChange({ disabledSkills: event.target.checked ? value.disabledSkills.filter(name => name !== skill.name) : [...value.disabledSkills, skill.name] })} /><div className="model-row-meta">{skill.modelInvocable && <span>{uiT('Agent 按需调用')}</span>}{skill.userInvocable && <span>{uiT('支持 /命令')}</span>}</div><details><summary>{uiT('查看指导内容')}</summary><pre className="prompt-preview">{skill.content}</pre></details>{!skill.enabled && <small className="muted">{uiT('上次保存的生效状态：停用（受总开关、功能依赖或单项选择影响）')}</small>}</section>)}{!query.data.skills.some(skill => (skill.name + skill.description).toLowerCase().includes(search.toLowerCase())) && <Empty title={search ? uiT('没有找到 Skills') : uiT('没有可用的 Skills')} action={search ? <Button onClick={() => setSearch('')}>{uiT('清空搜索')}</Button> : undefined} />}</SettingsGroup></>}
    {!!query.data?.diagnostics.length && <details open><summary>{uiT('目录读取提示')}</summary><JsonView value={query.data.diagnostics} /></details>}
  </>
}
