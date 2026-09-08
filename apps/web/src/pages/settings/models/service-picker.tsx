import { useRef, type KeyboardEvent } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import { Input } from '../../../components/ui.tsx'
import { uiT } from '../../../lib/i18n.ts'
import { useMediaQuery } from '../../../lib/use-media-query.ts'
import { customService, matchingServices, type ServicePreset } from './service-presets.ts'
import { ServiceLogo } from './service-logo.tsx'

export function ServicePicker({ search, onSearch, onSelect }: { search: string; onSearch: (value: string) => void; onSelect: (service: ServicePreset) => void }) {
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), services = matchingServices(search)
  const autoFocusSearch = useMediaQuery('(min-width: 801px) and (pointer: fine)')
  const groups = search.trim() ? [{ label: '搜索结果', items: services }] : [
    { label: '常用服务', items: services.filter(service => service.common) },
    { label: '更多服务', items: services.filter(service => !service.common) },
  ]
  function navigate(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.target === input.current && event.key === 'Enter') {
      event.preventDefault()
      if (services.length === 1) onSelect(services[0]!)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.service-option') ?? [])
    const index = buttons.indexOf(event.target as HTMLButtonElement), direction = event.key === 'ArrowDown' ? 1 : -1
    const next = index < 0 ? direction > 0 ? 0 : buttons.length - 1 : (index + direction + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus({ preventScroll: true })
    buttons[next]?.scrollIntoView({ block: 'nearest' })
  }
  return <div className="service-picker" ref={root} onKeyDown={navigate}>
    <p className="muted">{uiT('选择你要使用的服务，下一步填写 API 密钥。')}</p>
    <div className="search-field"><Search size={16} aria-hidden="true" /><Input ref={input} type="search" autoFocus={autoFocusSearch} aria-label={uiT('搜索模型服务')} placeholder={uiT('搜索服务或模型')} value={search} onChange={event => { onSearch(event.target.value); root.current?.querySelector('.service-results')?.scrollTo(0, 0) }} /></div>
    <div className="service-results" aria-label={uiT('可连接的模型服务')}>
      {groups.map(group => group.items.length > 0 && <section className="service-group" key={group.label} aria-label={uiT(group.label)}><h3 aria-live="polite" aria-atomic="true">{uiT(group.label)}<span>{group.items.length}</span></h3>{group.items.map(service => <ServiceOption key={service.id} service={service} onSelect={onSelect} />)}</section>)}
      {!services.length && <div className="service-empty" role="status"><strong>{uiT('没有找到匹配服务')}</strong><p>{uiT('可以通过下方的“其他服务”填写连接地址。')}</p></div>}
    </div>
    <div className="service-custom"><ServiceOption service={customService} onSelect={onSelect} /></div>
  </div>
}

function ServiceOption({ service, onSelect }: { service: ServicePreset; onSelect: (service: ServicePreset) => void }) {
  return <button type="button" className="service-option" onClick={() => onSelect(service)}>
    <ServiceLogo id={service.id} />
    <span className="service-option-copy"><strong>{uiT(service.label)}</strong><small>{uiT(service.description)}</small></span>
    <ChevronRight size={15} aria-hidden="true" />
  </button>
}
