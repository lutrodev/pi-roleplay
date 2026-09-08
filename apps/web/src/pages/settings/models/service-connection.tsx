import { ExternalLink } from 'lucide-react'
import type { ModelConnection } from '../../../../../../apps/server/src/services/model-inspection.ts'
import { Field, Input } from '../../../components/ui.tsx'
import { uiT } from '../../../lib/i18n.ts'
import { ConnectionAddressFields, ConnectionKeyField } from './connection-editor.tsx'
import type { ServicePreset } from './service-presets.ts'
import { ServiceLogo } from './service-logo.tsx'

export function ServiceConnection({ service, label, setLabel, connection, onConnection, apiKey, setKey }: {
  service: ServicePreset; label: string; setLabel: (label: string) => void
  connection: ModelConnection; onConnection: (connection: ModelConnection) => void
  apiKey: string; setKey: (key: string) => void
}) {
  const custom = service.id === 'custom'
  const nameField = <Field label={uiT('连接名称')}><Input autoFocus={custom} required maxLength={200} value={label} onChange={event => setLabel(event.target.value)} placeholder={uiT('例如：我的模型服务')} /></Field>
  return <>
    <div className="service-connection-summary"><ServiceLogo id={service.id} /><div><strong>{uiT(service.label)}</strong><small>{uiT(service.description)}</small></div>{service.docsUrl && <a href={service.docsUrl} target="_blank" rel="noreferrer">{uiT('接入指南')}<ExternalLink size={13} aria-hidden="true" /></a>}</div>
    {custom && nameField}
    <ConnectionKeyField apiKey={apiKey} setKey={setKey} autoFocus={!custom} />
    {service.note && <p className="muted">{uiT(service.note)}</p>}
    {custom ? <ConnectionAddressFields connection={connection} onChange={onConnection} /> : <details className="provider-advanced"><summary>{uiT('自定义设置')}<small>{uiT('连接名称、地址与协议')}</small></summary><div className="stack">{nameField}<ConnectionAddressFields connection={connection} onChange={onConnection} /></div></details>}
    <p className="muted">{uiT('也可以先保存模型，稍后再填写密钥。')}</p>
  </>
}
