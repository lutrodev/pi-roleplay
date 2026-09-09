import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { ApiError } from './api-error.ts'
import { recoverFailedReads } from './query-client.ts'

export const ConnectionFeedbackContext = createContext<{ error: Error | null; notice?: ReactNode }>({ error: null })
export const useConnectionFeedback = () => useContext(ConnectionFeedbackContext)
export const useSharedConnectionError = () => useConnectionFeedback().error

const offlineError = new ApiError('网络已断开。', 'NETWORK_ERROR', 0)
const subscribe = (notify: () => void) => {
  window.addEventListener('online', notify); window.addEventListener('offline', notify)
  return () => { window.removeEventListener('online', notify); window.removeEventListener('offline', notify) }
}

/** Keep the workspace mounted, with one owner for shared failure and read recovery. */
export function useWorkspaceConnection(auth: UseQueryResult<{ authenticated: boolean; configured: boolean }>) {
  const client = useQueryClient()
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true)
  const wasOnline = useRef(online)
  const failure = online ? auth.error : offlineError
  const [heldError, holdError] = useState<Error | null>(null), [recovering, setRecovering] = useState(false)
  useEffect(() => { if (failure) holdError(failure) }, [failure])
  useEffect(() => {
    if (online && !wasOnline.current) void auth.refetch({ cancelRefetch: false })
    wasOnline.current = online
  }, [online, auth.refetch])
  useEffect(() => {
    if (!online || auth.error || auth.isFetching || !auth.data) { setRecovering(false); return }
    if (!auth.data.authenticated) { holdError(null); setRecovering(false); return }
    let current = true
    setRecovering(true)
    void recoverFailedReads(client).finally(() => {
      if (current) { holdError(null); setRecovering(false) }
    })
    return () => { current = false }
  }, [online, auth.dataUpdatedAt, auth.error, auth.isFetching, client])
  return { error: failure ?? heldError, offline: !online, busy: auth.isFetching || recovering }
}
