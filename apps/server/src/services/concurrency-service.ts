import { DEFAULT_CONCURRENCY, normalizeConcurrency, type ConcurrencySettings } from '../../../../packages/rp-core/src/settings/concurrency.ts'
import { objectInput } from '../../../../packages/rp-core/src/input.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { AssetRepository } from '../storage/asset-repository.ts'

export interface ConcurrencySnapshot { revision: number; settings: ConcurrencySettings }
const storageKey = 'models.concurrency'
export class ConcurrencyService {
  constructor(readonly assets: AssetRepository, readonly changed: () => void = () => {}) {
    if (assets.getSetting(storageKey) === undefined) this.save({ revision: 1, settings: { ...DEFAULT_CONCURRENCY } })
    this.snapshot()
  }
  snapshot(): ConcurrencySnapshot {
    try {
      const value = this.assets.getSetting(storageKey)
      objectInput(value)
      requireValue(value.version === 1 && Number.isSafeInteger(value.revision) && Number(value.revision) > 0, 'CONCURRENCY_CORRUPT', '并发设置版本不正确。')
      return { revision: Number(value.revision), settings: normalizeConcurrency(value.settings) }
    } catch { throw new RpError('CONCURRENCY_CORRUPT', '保存的并发设置无法读取，请检查数据库或从备份恢复。', 500) }
  }
  update(expectedRevision: number, input: unknown) {
    const settings = normalizeConcurrency(input)
    this.assets.database.transaction(() => {
      const current = this.snapshot()
      requireValue(current.revision === expectedRevision, 'REVISION_CONFLICT', '并发设置已经更新，请刷新后再保存。', 409)
      this.save({ revision: current.revision + 1, settings })
    })
    this.changed()
    return this.snapshot()
  }
  private save(value: ConcurrencySnapshot) { this.assets.setSetting(storageKey, { version: 1, revision: value.revision, settings: { ...value.settings } }) }
}
