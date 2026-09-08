import { randomUUID } from 'node:crypto'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { directoriesOverlap, workspaceAccess, workspaceName, type WorkspaceAccess, type WorkspaceBinding, type WorkspaceRecord } from '../../../../packages/rp-core/src/workspace.ts'
import type { StoryRepository } from '../storage/story-repository.ts'
import type { ToolClient } from '../runtime/tool-client.ts'

const columns = 'id,name,directory,access,revision,created_at AS createdAt,updated_at AS updatedAt'

export class WorkspaceService {
  constructor(readonly stories: StoryRepository, readonly tools: ToolClient) {}
  private get db() { return this.stories.database }
  list(): WorkspaceRecord[] { return this.db.sqlite.prepare(`SELECT ${columns} FROM workspaces ORDER BY created_at,id`).all() as WorkspaceRecord[] }
  get(id: string): WorkspaceRecord {
    const row = this.db.sqlite.prepare(`SELECT ${columns} FROM workspaces WHERE id=?`).get(id) as WorkspaceRecord | undefined
    requireValue(row, 'WORKSPACE_NOT_FOUND', '工作区已不存在，请重新选择。', 404)
    return row
  }
  forStory(id: string): WorkspaceBinding {
    this.stories.assertExists(id)
    const binding = this.stories.workspaceBinding(id)
    if (!binding.workspaceId) {
      const shared = this.list().find(item => item.directory === binding.directory)
      return shared ? { ...binding, access: shared.access, createIfMissing: false } : binding
    }
    const workspace = this.get(binding.workspaceId)
    return { workspaceId: workspace.id, directory: workspace.directory, access: workspace.access, createIfMissing: false }
  }
  storyInfo(id: string) {
    const binding = this.forStory(id)
    const revision = (this.db.sqlite.prepare("SELECT max(seq) AS revision FROM events WHERE story_id=? AND type IN ('story.created','workspace.changed')").get(id) as { revision: number }).revision
    return { binding, name: binding.workspaceId ? this.get(binding.workspaceId).name : null, revision }
  }
  private assertAvailable(directory: string) {
    requireValue(!this.list().some(item => directoriesOverlap(item.directory, directory)), 'WORKSPACE_DIRECTORY_LINKED', '这个目录或它的上下级目录已经关联到工作区，请直接选择已有工作区。', 409)
  }
  async create(input: { name: string; access?: WorkspaceAccess }) {
    const name = workspaceName(input.name), access = workspaceAccess(input.access ?? 'read-write')
    // Display names never become paths. Every new workspace gets its own directory in the managed volume.
    const id = randomUUID(), directory = `workspace-${id}`
    this.assertAvailable(directory)
    await this.tools.prepareDirectory(directory)
    return this.db.transaction(() => {
      this.assertAvailable(directory)
      const now = new Date().toISOString()
      this.db.sqlite.prepare('INSERT INTO workspaces VALUES (?,?,?,?,1,?,?)').run(id, name, directory, access, now, now)
      return this.get(id)
    })
  }
  update(id: string, expectedRevision: number, input: { name: string; access: WorkspaceAccess }) {
    const name = workspaceName(input.name), access = workspaceAccess(input.access)
    return this.db.transaction(() => {
      const current = this.get(id)
      requireValue(current.revision === expectedRevision, 'REVISION_CONFLICT', '工作区已更新，请重新打开后再保存。', 409)
      if (current.access !== access) for (const story of [...this.stories.list(), ...this.stories.list(true)]) if (this.forStory(story.id).directory === current.directory) this.stories.assertIdle(story.id)
      this.db.sqlite.prepare('UPDATE workspaces SET name=?,access=?,revision=revision+1,updated_at=? WHERE id=?').run(name, access, new Date().toISOString(), id)
      return this.get(id)
    })
  }
  remove(id: string, expectedRevision: number) {
    return this.db.transaction(() => {
      const current = this.get(id)
      requireValue(current.revision === expectedRevision, 'REVISION_CONFLICT', '工作区已更新，请重新打开后再保存。', 409)
      const members = [...this.stories.list(), ...this.stories.list(true)].filter(story => this.forStory(story.id).directory === current.directory)
      for (const story of members) this.stories.assertIdle(story.id)
      for (const story of members) this.stories.append(story.id, { type: 'workspace.changed', data: { workspaceId: null, directory: current.directory, access: current.access, createIfMissing: false } })
      this.db.sqlite.prepare('DELETE FROM workspaces WHERE id=?').run(id)
      return { removed: true, filesRetained: true, sessionsRetained: members.length }
    })
  }
  associate(storyId: string, expectedRevision: number, workspaceId: string | null, access?: WorkspaceAccess) {
    return this.db.transaction(() => {
      this.stories.assertIdle(storyId)
      requireValue(this.storyInfo(storyId).revision === expectedRevision, 'REVISION_CONFLICT', '会话工作区已更新，请重新打开后再保存。', 409)
      const current = this.forStory(storyId)
      const shared = this.list().find(item => item.directory === current.directory)
      if (!workspaceId && access && shared) requireValue(access === shared.access, 'WORKSPACE_ACCESS_CONFLICT', '该目录仍由共享工作区管理，请在工作区管理中修改权限。', 409)
      const next: WorkspaceBinding = workspaceId ? { ...this.get(workspaceId), workspaceId, createIfMissing: false } : { ...current, workspaceId: null, ...(access ? { access: workspaceAccess(access) } : {}) }
      if (!workspaceId && access && current.workspaceId) requireValue(access === current.access, 'WORKSPACE_ACCESS_CONFLICT', '请先在工作区管理中修改权限，或移除会话关联后再修改。', 409)
      this.stories.append(storyId, { type: 'workspace.changed', data: { workspaceId: next.workspaceId, directory: next.directory, access: next.access, createIfMissing: next.createIfMissing } })
      return this.storyInfo(storyId)
    })
  }
}
