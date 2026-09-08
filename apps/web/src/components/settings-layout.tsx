import { useId, type ReactNode } from 'react'
import { clsx } from 'clsx'

/** A single copy block is centered against its controls, with or without help text. */
export function SettingRow({ label, help, children, as: Tag = 'div', kind = 'action', labelId, helpId, className }: {
  label: ReactNode; help?: ReactNode; children: ReactNode; as?: 'div' | 'label';
  kind?: 'field' | 'toggle' | 'segmented' | 'slider' | 'action'; labelId?: string; helpId?: string; className?: string
}) {
  const Block = Tag === 'label' ? 'span' : 'div'
  return <Tag className={clsx('setting-row', `setting-row-${kind}`, className)}>
    <Block className="setting-copy"><span id={labelId} className="setting-label">{label}</span>{help && <span id={helpId} className="setting-help">{help}</span>}</Block>
    <Block className="setting-control">{children}</Block>
  </Tag>
}

/** The same grouping is used in settings pages, dialogs and conversation panels. */
export function SettingsGroup({ title, description, actions, children, layout = 'rows', className }: {
  title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode;
  layout?: 'rows' | 'form'; className?: string
}) {
  const id = useId()
  return <section className={clsx('settings-group', `settings-group-${layout}`, className)} aria-labelledby={title ? id : undefined}>
    {(title || description || actions) && <header className="settings-group-heading"><div>{title && <h3 id={id}>{title}</h3>}{description && <p>{description}</p>}</div>{actions && <div className="settings-group-actions">{actions}</div>}</header>}
    <div className="settings-group-body">{children}</div>
  </section>
}
