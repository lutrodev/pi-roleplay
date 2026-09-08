import { useQuery } from '@tanstack/react-query'
import type { SidebarSettings, SidebarUpdate } from '../../../../packages/protocol/src/sidebar.ts'
import type { WorkspaceRecord } from '../../../../packages/rp-core/src/workspace.ts'
import { api, queryClient } from './api.ts'
import type { StoryListItem } from './story-list.ts'

export type { SidebarSettings } from '../../../../packages/protocol/src/sidebar.ts'
const queryKey = ['sidebar-order']
export function useSidebarSettings() {
  return useQuery({ queryKey, queryFn: ({ signal }) => api<SidebarSettings>('/settings/sidebar', 'GET', undefined, signal), refetchInterval: 15000 })
}
async function save(path: string, method: string, payload: object) {
  try {
    const next = await api<SidebarSettings>(path, method, payload)
    queryClient.setQueryData(queryKey, next)
  } finally {
    // A conflict refreshes the menu; unsaved sort editors retain their own baseline.
    await queryClient.invalidateQueries({ queryKey })
  }
}
export function updateSidebar(settings: SidebarSettings, patch: Partial<SidebarUpdate>) {
  const { revision, sort, order, view, workspaceOrder, pinnedStoryIds } = settings
  return save('/settings/sidebar', 'PUT', { expectedRevision: revision, sort, order, view, workspaceOrder, pinnedStoryIds, ...patch })
}
export function pinStory(settings: SidebarSettings, storyId: string, pinned: boolean) {
  return save(`/settings/sidebar/pins/${encodeURIComponent(storyId)}`, 'PATCH', { expectedRevision: settings.revision, pinned })
}
export function orderedStories(stories: StoryListItem[], settings?: Pick<SidebarSettings, 'sort' | 'order'>) {
  if (settings?.sort !== 'manual') return stories
  const indices = new Map(settings.order.map((id, index) => [id, index]))
  return [...stories].sort((a, b) => (indices.get(a.id) ?? -1) - (indices.get(b.id) ?? -1))
}
export function sidebarSections(stories: StoryListItem[], settings: SidebarSettings) {
  const active = stories.filter(story => !story.archived), byId = new Map(active.map(story => [story.id, story]))
  const pinned = settings.pinnedStoryIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
  const ids = new Set(settings.pinnedStoryIds)
  return { pinned, regular: orderedStories(active.filter(story => !ids.has(story.id)), settings) }
}
export function workspaceGroups(stories: StoryListItem[], workspaces: WorkspaceRecord[], settings: SidebarSettings) {
  const names = new Map(workspaces.map(workspace => [workspace.id, workspace.name]))
  const memberships = new Map<string, StoryListItem[]>()
  for (const story of stories) if (story.workspaceId) {
    const members = memberships.get(story.workspaceId) ?? []
    members.push(story); memberships.set(story.workspaceId, members)
  }
  // A second window may create a workspace before this window's catalog refreshes.
  // Keep its conversations reachable while the workspace name is being fetched.
  const groups = [...memberships].map(([id, members]) => ({ id, name: names.get(id) ?? '', stories: members }))
  const indices = new Map(settings.workspaceOrder.map((id, index) => [id, index]))
  const recent = (members: StoryListItem[]) => members.reduce((time, story) => story.updatedAt > time ? story.updatedAt : time, '')
  groups.sort((a, b) => settings.sort === 'manual' ? (indices.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (indices.get(b.id) ?? Number.MAX_SAFE_INTEGER) : recent(b.stories).localeCompare(recent(a.stories)))
  const independent = stories.filter(story => !story.workspaceId)
  return [...groups, ...(independent.length ? [{ id: '', name: '', stories: independent }] : [])]
}

/** Keep the selected row reachable even when it lies beyond the first rendered page. */
export function visibleStoryCount(stories: StoryListItem[], requested: number, selectedId?: string) {
  return Math.max(requested, selectedId ? stories.findIndex(story => story.id === selectedId) + 1 : 0)
}
