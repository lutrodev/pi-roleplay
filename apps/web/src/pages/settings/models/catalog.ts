import type { ModelRegistration } from '../../../../../../apps/server/src/runtime/models.ts'
import type { ModelCheck, ModelConnection } from '../../../../../../apps/server/src/services/model-inspection.ts'
import { api, queryClient, type ModelInfo } from '../../../lib/api.ts'
import { serviceForConnection } from './service-presets.ts'

export type ModelFields = Omit<ModelRegistration, 'provider' | 'keyEnv'>
export type CatalogModel = ModelFields & { configured: boolean; check: ModelCheck | null; effective: ModelInfo }
export interface Provider { id: string; label: string; keyStored: boolean; credentialConfigured: boolean; connection: ModelConnection; models: CatalogModel[] }
export interface Catalog { revision: number; providers: Provider[] }
export interface Discovery { discoveryId: string; truncated?: boolean; models: { model: string; label: string; effective: Pick<ModelInfo, 'label' | 'input' | 'reasoning' | 'contextWindow' | 'maxTokens' | 'sources'> }[] }
export const fields = ({ configured: _configured, check: _check, effective: _effective, ...model }: CatalogModel): ModelFields => model
export const freshModel = (connection: ModelConnection, model = '', label = ''): ModelFields => {
  const compat = serviceForConnection(connection)?.compat
  return { model, ...(label ? { label } : {}), ...connection, ...(compat ? { compat: { ...compat } } : {}) }
}
export async function refreshModels() { await Promise.all(['providers', 'models', 'model-metadata', 'system-status', 'prompt-projection'].map(key => queryClient.invalidateQueries({ queryKey: [key] }))) }
export async function saveModels(provider: Provider, revision: number, models: ModelFields[], discoveryId?: string) {
  await api('/settings/providers', 'PUT', { expectedRevision: revision, provider: { id: provider.id, label: provider.label, connection: provider.connection, models, discoveryId } })
  await refreshModels()
}
