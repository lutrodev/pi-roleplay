import { Plus } from 'lucide-react'
import logos from '../../../assets/provider-logos.svg'
import type { ModelConnection } from '../../../../../../apps/server/src/services/model-inspection.ts'
import { serviceForConnection } from './service-presets.ts'

export function ServiceLogo({ id }: { id: string }) {
  return <span className="service-symbol" aria-hidden="true">{id === 'custom' ? <Plus size={18} /> : <svg className="service-logo" focusable="false"><use href={`${logos}#${id}`} /></svg>}</span>
}

export function ConnectionLogo({ connection, label }: { connection: ModelConnection; label: string }) {
  const service = serviceForConnection(connection)
  return service ? <ServiceLogo id={service.id} /> : <span className="service-symbol" aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>
}
