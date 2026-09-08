import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { StoryRepository } from '../storage/story-repository.ts'
import type { SidebarService } from './sidebar-service.ts'
import { ModelHistoryService } from './model-history-service.ts'

/** Delete owned records atomically; shared resources and independent branches survive. */
export class StoryDeletionService {
  constructor(readonly stories: StoryRepository, readonly sidebar: SidebarService, readonly hasBackgroundJob: (storyId: string) => boolean) {}

  delete(storyId: string, expectedRevision: number) {
    return this.stories.database.transaction(() => {
      const db = this.stories.database.sqlite
      // Retrying a successful request cannot restore or accidentally target another story.
      if (db.prepare('SELECT id FROM deleted_stories WHERE id = ?').get(storyId)) return
      this.stories.assertIdle(storyId)
      requireValue(!this.hasBackgroundJob(storyId), 'STORY_BACKGROUND_BUSY', '后台任务尚未结束，请稍后再删除会话。', 409)
      this.stories.assertRevision(storyId, expectedRevision)
      const history = new ModelHistoryService(this.stories)
      const branches = db.prepare("SELECT story_id AS id FROM events WHERE type = 'story.created' AND json_extract(data, '$.forkedFrom.storyId') = ?").all(storyId) as { id: string }[]
      for (const branch of branches) history.restoreBranch(branch.id)
      this.preserveBranchWorkspaces(storyId)
      db.prepare('DELETE FROM pending_inputs WHERE story_id = ?').run(storyId)
      db.prepare('DELETE FROM stories WHERE id = ?').run(storyId)
      db.prepare('INSERT INTO deleted_stories (id, deleted_at) VALUES (?, ?)').run(storyId, new Date().toISOString())
      this.sidebar.snapshot()
    })
  }

  private preserveBranchWorkspaces(storyId: string) {
    const db = this.stories.database.sqlite
    const created = db.prepare("SELECT story_id AS id, json_extract(data, '$.forkedFrom.storyId') AS parent FROM events WHERE type = 'story.created'").all() as { id: string; parent: string | null }[]
    const parents = new Map(created.map(row => [row.id, row.parent]))
    const unbound = db.prepare("SELECT id FROM stories WHERE id != ? AND NOT EXISTS (SELECT 1 FROM events WHERE story_id = stories.id AND type = 'workspace.changed')").all(storyId) as { id: string }[]
    // Resolve every old inherited binding before changing the lineage underneath it.
    const bindings = unbound.flatMap(({ id }) => {
      const seen = new Set<string>()
      let parent = parents.get(id)
      while (parent && !seen.has(parent)) {
        if (parent === storyId) return [{ id, binding: this.stories.workspaceBinding(id) }]
        seen.add(parent); parent = parents.get(parent)
      }
      return []
    })
    for (const { id, binding } of bindings) this.stories.append(id, { type: 'workspace.changed', data: binding })
  }
}
