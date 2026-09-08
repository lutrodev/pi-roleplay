import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { SidebarSettings } from '../../../../packages/protocol/src/sidebar.ts'
import type { AssetRepository } from '../storage/asset-repository.ts'
import type { StoryRepository } from '../storage/story-repository.ts'

const key = 'app.sidebar'
const ids = (value: unknown, limit: number): value is string[] => Array.isArray(value) && value.length <= limit && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128) && new Set(value).size === value.length

export class SidebarService {
  constructor(readonly assets: AssetRepository, readonly stories: StoryRepository) {}

  snapshot(): SidebarSettings {
    return this.assets.database.transaction(() => {
      const saved = this.assets.getSetting(key)
      if (saved === undefined) return { version: 3, revision: 1, sort: 'recent', order: [], view: 'single', workspaceOrder: [], pinnedStoryIds: [] }
      requireValue(saved && typeof saved === 'object' && !Array.isArray(saved) && (saved.version === 1 || saved.version === 2 || saved.version === 3) && Number.isSafeInteger(saved.revision) && Number(saved.revision) >= 1 && (saved.sort === 'recent' || saved.sort === 'manual') && ids(saved.order, 10000), 'SETTINGS_CORRUPT', '会话排序设置损坏，请从备份恢复。', 500)
      if (saved.version !== 1) requireValue((saved.view === 'single' || saved.view === 'workspaces') && ids(saved.workspaceOrder, 1000), 'SETTINGS_CORRUPT', '工作区排序设置损坏，请从备份恢复。', 500)
      if (saved.version === 3) requireValue(ids(saved.pinnedStoryIds, 10000), 'SETTINGS_CORRUPT', '置顶会话设置损坏，请从备份恢复。', 500)
      const next: SidebarSettings = {
        version: 3, revision: Number(saved.revision), sort: saved.sort as SidebarSettings['sort'], order: (saved.order as string[]).filter(id => this.stories.exists(id)),
        view: saved.version === 1 ? 'single' : saved.view as SidebarSettings['view'],
        workspaceOrder: saved.version === 1 ? [] : (saved.workspaceOrder as string[]).filter(id => this.assets.database.sqlite.prepare('SELECT id FROM workspaces WHERE id=?').get(id)),
        pinnedStoryIds: saved.version === 3 ? (saved.pinnedStoryIds as string[]).filter(id => this.stories.exists(id)) : [],
      }
      // Only actual deletion removes a pin. Archiving never changes its saved position.
      const removed = next.order.length !== (saved.order as string[]).length || (saved.version !== 1 && next.workspaceOrder.length !== (saved.workspaceOrder as string[]).length) || (saved.version === 3 && next.pinnedStoryIds.length !== (saved.pinnedStoryIds as string[]).length)
      if (removed) next.revision++
      if (saved.version !== 3 || removed) this.assets.setSetting(key, { ...next })
      return next
    })
  }

  update(expectedRevision: number, sort: SidebarSettings['sort'], order: string[], view: SidebarSettings['view'], workspaceOrder: string[], pinnedStoryIds: string[]) {
    requireValue((sort === 'recent' || sort === 'manual') && ids(order, 10000), 'INVALID_ORDER', '会话排序不正确。')
    requireValue(ids(pinnedStoryIds, 10000), 'INVALID_PINS', '置顶会话列表不正确。')
    return this.assets.database.transaction(() => {
      const saved = this.snapshot()
      requireValue(saved.revision === expectedRevision, 'REVISION_CONFLICT', '侧边栏已更新，请重新打开后再保存。', 409)
      for (const id of new Set([...order, ...pinnedStoryIds])) this.stories.assertExists(id)
      requireValue((view === 'single' || view === 'workspaces') && ids(workspaceOrder, 1000), 'INVALID_ORDER', '工作区排序不正确。')
      for (const id of workspaceOrder) requireValue(this.assets.database.sqlite.prepare('SELECT id FROM workspaces WHERE id=?').get(id), 'WORKSPACE_NOT_FOUND', '工作区已不存在，请重新选择。', 404)
      const next: SidebarSettings = { version: 3, revision: saved.revision + 1, sort, order: [...order], view, workspaceOrder: [...workspaceOrder], pinnedStoryIds: [...pinnedStoryIds] }
      this.assets.setSetting(key, { ...next }); return next
    })
  }

  pin(expectedRevision: number, storyId: string, pinned: boolean) {
    requireValue(typeof pinned === 'boolean', 'INVALID_PINS', '置顶会话列表不正确。')
    return this.assets.database.transaction(() => {
      const saved = this.snapshot()
      this.stories.assertExists(storyId)
      const next = pinned ? saved.pinnedStoryIds.includes(storyId) ? saved.pinnedStoryIds : [...saved.pinnedStoryIds, storyId] : saved.pinnedStoryIds.filter(id => id !== storyId)
      return this.update(expectedRevision, saved.sort, saved.order, saved.view, saved.workspaceOrder, next)
    })
  }
}
