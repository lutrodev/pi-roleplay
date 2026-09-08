import { useQuery } from '@tanstack/react-query'
import type { WorkspaceBinding, WorkspaceRecord } from '../../../../packages/rp-core/src/workspace.ts'
import { api, queryClient, refreshStory } from './api.ts'

export interface StoryWorkspace { binding: WorkspaceBinding; name: string | null; revision: number }
export function useWorkspaces() { return useQuery({ queryKey: ['workspaces'], queryFn: ({ signal }) => api<{ workspaces: WorkspaceRecord[] }>('/workspaces', 'GET', undefined, signal) }) }
export function useStoryWorkspace(storyId: string, enabled = true) { return useQuery({ enabled, queryKey: ['story-workspace', storyId], queryFn: ({ signal }) => api<StoryWorkspace>(`/stories/${storyId}/workspace`, 'GET', undefined, signal) }) }
export async function refreshWorkspaces(storyId?: string) {
  await Promise.all([queryClient.invalidateQueries({ queryKey: ['workspaces'] }), queryClient.invalidateQueries({ queryKey: ['story-workspace'] }), queryClient.invalidateQueries({ queryKey: ['workspace'] }), queryClient.invalidateQueries({ queryKey: ['workspace-preview'] }), queryClient.invalidateQueries({ queryKey: ['stories'] }), ...(storyId ? [refreshStory(storyId)] : [])])
}
