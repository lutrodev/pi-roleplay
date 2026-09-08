import { createHash } from 'node:crypto'
import { compileWriterHistory, normalizeWriterHistory, type FrozenWriterHistory, type WriterHistorySettings } from '../../../../packages/rp-core/src/agents/writer-history.ts'
import { exampleWriterHistory } from '../../../../packages/rp-core/src/agents/writer-history-example.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { JsonValue } from '../../../../packages/rp-core/src/types.ts'
import type { AssetRepository } from '../storage/asset-repository.ts'

const storageKey = 'writer.history'

/** One global, versioned SQLite record. A transaction provides atomic replacement and revision CAS. */
export class WriterHistoryService {
  constructor(readonly assets: AssetRepository) {
    if (assets.getSetting(storageKey) === undefined) this.save({ version: 1, revision: 1, config: exampleWriterHistory() })
  }
  snapshot(): WriterHistorySettings {
    try {
      const value = this.assets.getSetting(storageKey)
      requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'config,revision,version'
        && value.version === 1 && Number.isSafeInteger(value.revision) && Number(value.revision) > 0, 'WRITER_HISTORY_CORRUPT', '预置历史版本不正确。')
      return { version: 1, revision: Number(value.revision), config: normalizeWriterHistory(value.config) }
    } catch { throw new RpError('WRITER_HISTORY_CORRUPT', '保存的 Writer 预置历史无法读取，请检查数据库或从备份恢复。', 500) }
  }
  update(expectedRevision: number, input: unknown) {
    const config = normalizeWriterHistory(input)
    return this.assets.database.transaction(() => {
      const current = this.snapshot()
      requireValue(current.revision === expectedRevision, 'REVISION_CONFLICT', 'Writer 预置历史已被更新，请重新读取后再保存。', 409)
      requireValue(Number.isSafeInteger(current.revision + 1), 'WRITER_HISTORY_CORRUPT', '预置历史版本已超出范围。', 500)
      const next: WriterHistorySettings = { version: 1, revision: current.revision + 1, config }
      this.save(next)
      return next
    })
  }
  capture(): FrozenWriterHistory | undefined {
    const { revision, config } = this.snapshot()
    if (!config.enabled) return undefined
    const messages = compileWriterHistory(config)
    return { metadata: { revision, digest: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
      messageCount: messages.length, toolCallCount: config.rounds.reduce((sum, round) => sum + round.steps.length, 0) }, messages }
  }
  private save(value: WriterHistorySettings) { this.assets.setSetting(storageKey, JSON.parse(JSON.stringify(value)) as JsonValue) }
}
