import { createHmac, randomUUID } from 'node:crypto'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { DiscoveredModel, ModelConnection } from './model-inspection.ts'
import type { ModelIdentity, ModelMetadata } from '../runtime/model-metadata.ts'

type Discovery = { connection: ModelConnection; credential: string; models: DiscoveredModel[]; expiresAt: number }
export interface StoredModelMetadata { connection: ModelConnection; value: ModelMetadata }
export type StoredMetadata = Record<string, StoredModelMetadata>
export const metadataKey = (route: Pick<ModelIdentity, 'provider' | 'model'>) => JSON.stringify([route.provider, route.model])
export const sameConnection = (a: Pick<ModelIdentity, 'api' | 'baseUrl'>, b: Pick<ModelIdentity, 'api' | 'baseUrl'>) => a.api === b.api && a.baseUrl?.replace(/\/+$/, '') === b.baseUrl?.replace(/\/+$/, '')
export function storedMetadata(metadata: StoredMetadata, route: ModelIdentity) {
  const entry = metadata[metadataKey(route)]
  return entry && sameConnection(entry.connection, route) ? entry.value : undefined
}

/** Draft discoveries never mutate live routing. Only selected models are retained on save. */
export class ModelDiscoveryCache {
  private drafts = new Map<string, Discovery>()
  constructor(private readonly secret: Buffer) {}
  add(connection: ModelConnection, key: string, models: DiscoveredModel[]) {
    for (const [id, draft] of this.drafts) if (draft.expiresAt <= Date.now()) this.drafts.delete(id)
    while (this.drafts.size >= 8) this.drafts.delete(this.drafts.keys().next().value!)
    const id = randomUUID()
    this.drafts.set(id, { connection, credential: this.fingerprint(key), models, expiresAt: Date.now() + 30 * 60_000 })
    return id
  }
  read(id: string, connection: ModelConnection, key?: string) {
    const draft = this.forSave(id, key)
    requireValue(sameConnection(draft.connection, connection), 'MODEL_DISCOVERY_EXPIRED', '连接已变更，请重新获取模型信息。', 409)
    return draft.models
  }
  forSave(id: string, key?: string) {
    const draft = this.drafts.get(id)
    requireValue(draft && draft.expiresAt > Date.now(), 'MODEL_DISCOVERY_EXPIRED', '识别结果已过期，请重新获取模型信息。', 409)
    requireValue(key === undefined || draft.credential === this.fingerprint(key), 'MODEL_DISCOVERY_EXPIRED', '密钥已变更，请重新获取模型信息。', 409)
    return { connection: draft.connection, models: draft.models }
  }
  clear() { this.drafts.clear() }
  private fingerprint(key: string) { return createHmac('sha256', this.secret).update(key).digest('hex') }
}
