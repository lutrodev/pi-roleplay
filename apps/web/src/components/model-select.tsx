import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Popover } from 'radix-ui'
import { useMediaQuery } from '../lib/use-media-query.ts'
import { Check, Search } from 'lucide-react'
import type { ModelRoute } from '../../../../packages/rp-core/src/types.ts'
import { useModels } from '../lib/api.ts'
import { uiT } from '../lib/i18n.ts'
import { Button, Empty, ErrorNotice, Input, Loading, Modal } from './ui.tsx'
import { ModelCapabilities } from './model-capabilities.tsx'

export interface ModelDefaultChoice { selected: boolean; label: string; detail: string; onSelect: () => void }
/** One searchable chooser for the composer, global defaults, Writer and task subagents. */
export function ModelSelect({ trigger, open, onOpenChange, value, onChange, inheritLabel, inheritDetail, defaultChoice, footer }: {
  trigger: ReactElement; open: boolean; onOpenChange: (open: boolean) => void; value: ModelRoute | null; onChange: (route: ModelRoute | null) => void
  inheritLabel?: string; inheritDetail?: string; defaultChoice?: ModelDefaultChoice; footer?: ReactNode
}) {
  const query = useModels(), [search, setSearch] = useState(''), list = useRef<HTMLDivElement>(null)
  const mobile = useMediaQuery('(max-width: 540px)')
  const models = query.data?.models ?? [], filtered = models.filter(model => [model.label, model.model, model.providerLabel].join(' ').toLowerCase().includes(search.toLowerCase()))
  const providers = [...new Set(filtered.map(model => model.provider))]
  const close = (next: boolean) => { onOpenChange(next); if (!next) setSearch('') }
  const choose = (route: ModelRoute | null) => { onChange(route); close(false) }
  const content = <div className="model-chooser"><div className="search-field"><Search size={16} aria-hidden="true" /><Input autoFocus aria-label={uiT('搜索可用模型')} placeholder={uiT('搜索模型名称、ID 或连接')} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() } }} /></div>
      <ErrorNotice source="read" error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />{query.isPending && <Loading />}
      <div className="model-options" ref={list} onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []), index = buttons.indexOf(event.target as HTMLButtonElement)
        if (index < 0) return
        event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      }}>
        {!search && (inheritLabel || defaultChoice) && <div className="model-inheritance-options">
          {defaultChoice && <button type="button" className="model-option" aria-pressed={defaultChoice.selected} onClick={() => { defaultChoice.onSelect(); close(false) }}><span><strong>{defaultChoice.label}</strong><small>{defaultChoice.detail}</small></span>{defaultChoice.selected && <Check size={16} />}</button>}
          {inheritLabel && <button type="button" className="model-option" aria-pressed={!value && !defaultChoice?.selected} onClick={() => choose(null)}><span><strong>{inheritLabel}</strong><small>{inheritDetail}</small></span>{!value && !defaultChoice?.selected && <Check size={16} />}</button>}
        </div>}
        {providers.map(provider => <section className="model-option-group" key={provider} aria-label={filtered.find(model => model.provider === provider)!.providerLabel}>
          <h3>{filtered.find(model => model.provider === provider)!.providerLabel}</h3>
          {filtered.filter(model => model.provider === provider).map(model => <button type="button" className="model-option" key={model.model} disabled={!model.configured} aria-pressed={!defaultChoice?.selected && model.provider === value?.provider && model.model === value.model} onClick={() => choose({ provider: model.provider, model: model.model })}>
            <span><strong>{model.label}</strong>{model.label !== model.model && <small className="model-option-id">{model.model}</small>}<ModelCapabilities model={model} />{!model.configured && <small>{uiT('缺少密钥')}</small>}</span>
            {!defaultChoice?.selected && model.provider === value?.provider && model.model === value.model && <Check size={16} />}
          </button>)}
        </section>)}
        {!query.error && !query.isPending && !filtered.length && <Empty title={search ? uiT('没有找到模型') : uiT('尚未配置模型')} action={search ? <Button onClick={() => setSearch('')}>{uiT('清空搜索')}</Button> : undefined}>{uiT('可以在设置的“模型”中添加服务连接。')}</Empty>}
      </div>
      {footer && <div className="model-chooser-footer">{footer}</div>}
    </div>
  return mobile ? <>{trigger}<Modal size="form" className="settings-modal model-picker-dialog" open={open} onOpenChange={close} title={uiT('选择模型')}>{content}</Modal></>
    : <Popover.Root open={open} onOpenChange={close} modal><Popover.Trigger asChild>{trigger}</Popover.Trigger><Popover.Portal><Popover.Content className="model-popover" side="bottom" align="end" sideOffset={8} collisionPadding={12} aria-label={uiT('选择模型')}>{content}</Popover.Content></Popover.Portal></Popover.Root>
}
