import { useQuery } from '@tanstack/react-query'
import type { BackgroundSnapshot } from '../../../../packages/protocol/src/backgrounds.ts'
import { api, queryClient } from './api.ts'

export function useBackgrounds() {
  return useQuery({ queryKey: ['backgrounds'], queryFn: ({ signal }) => api<BackgroundSnapshot>('/settings/backgrounds', 'GET', undefined, signal) })
}
export function cacheBackgrounds(snapshot: BackgroundSnapshot) { queryClient.setQueryData(['backgrounds'], snapshot) }
export function backgroundUrl(id: string, thumbnail = false) { return `/api/settings/backgrounds/${encodeURIComponent(id)}/content${thumbnail ? '?thumbnail=true' : ''}` }
