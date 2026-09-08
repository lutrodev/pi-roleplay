import { DEFAULT_PREFERENCES, normalizePreferences, type Preferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { JsonValue } from '../../../../packages/rp-core/src/types.ts'
import type { ModelRegistry } from '../runtime/models.ts'
import { migrateStoryFeatures, upgradePreferences } from './settings-migration.ts'
import type { AssetRepository } from '../storage/asset-repository.ts'

export interface SettingsSnapshot { version: 8; revision: number; preferences: Preferences }
const key = 'app.preferences'

export class SettingsService {
  constructor(readonly assets: AssetRepository, readonly models: ModelRegistry) {}
  snapshot(): SettingsSnapshot {
    return this.assets.database.transaction(() => {
      const value = this.assets.getSetting(key)
      if (value === undefined) {
        const initial: SettingsSnapshot = { version: 8, revision: 1, preferences: structuredClone(DEFAULT_PREFERENCES) }
        this.save(initial); return initial
      }
      try {
        requireValue(value && typeof value === 'object' && !Array.isArray(value) && typeof value.version === 'number' && [1, 2, 3, 4, 5, 6, 7, 8].includes(value.version) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1, 'INVALID_SETTINGS', '设置版本不正确。')
        if (value.version !== 8) {
          const { preferences, features } = upgradePreferences(value.preferences, value.version)
          migrateStoryFeatures(this.assets.database, features)
          const upgraded: SettingsSnapshot = { version: 8, revision: Number(value.revision) + 1, preferences }
          this.save(upgraded); return upgraded
        }
        return { version: 8, revision: Number(value.revision), preferences: normalizePreferences(value.preferences) }
      } catch { throw new RpError('SETTINGS_CORRUPT', '应用设置已损坏，请检查数据库或从备份恢复。', 500) }
    })
  }
  update(expectedRevision: number, input: unknown) {
    const preferences = normalizePreferences(input)
    return this.assets.database.transaction(() => {
      const current = this.snapshot()
      requireValue(current.revision === expectedRevision, 'REVISION_CONFLICT', '系统设置已经更新，请刷新后再保存。', 409)
      // A removed model remains an explicit unavailable selection. It must not block unrelated preferences.
      if (preferences.mainModel && JSON.stringify(preferences.mainModel) !== JSON.stringify(current.preferences.mainModel)) this.models.resolve(preferences.mainModel)
      const updated: SettingsSnapshot = { version: 8, revision: current.revision + 1, preferences }
      this.save(updated); return updated
    })
  }
  private save(value: SettingsSnapshot) { this.assets.setSetting(key, JSON.parse(JSON.stringify(value)) as JsonValue) }
}
