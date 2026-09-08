/** Navigation preferences are independent of story facts and file permissions. */
export interface SidebarSettings {
  version: 3
  revision: number
  sort: 'recent' | 'manual'
  order: string[]
  view: 'single' | 'workspaces'
  workspaceOrder: string[]
  /** Retain archived pins so restoring a story restores its pinned position. */
  pinnedStoryIds: string[]
}

export type SidebarUpdate = Pick<SidebarSettings, 'sort' | 'order' | 'view' | 'workspaceOrder' | 'pinnedStoryIds'>
