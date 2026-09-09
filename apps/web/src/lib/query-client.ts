import { QueryCache, QueryClient } from '@tanstack/react-query'
import { connectionFailure } from './api-error.ts'

const recovering = new WeakMap<QueryClient, Promise<void>>()

/** Recover mounted reads only. Mutations, user actions and inactive caches are never replayed. */
export function recoverFailedReads(client: QueryClient) {
  const pending = recovering.get(client)
  if (pending) return pending
  const recovery = client.refetchQueries({ type: 'active', predicate: query =>
    query.queryKey[0] !== 'auth' && connectionFailure(query.state.error) !== null,
  }, { cancelRefetch: false }).finally(() => recovering.delete(client))
  recovering.set(client, recovery)
  return recovery
}

export function createQueryClient() {
  let probing = false
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: 15000, retry: false, refetchOnWindowFocus: true }, mutations: { retry: false } },
    queryCache: new QueryCache({ onError: (error, query) => {
      if (query.queryKey[0] === 'auth' || !connectionFailure(error) || probing || recovering.has(client)) return
      const auth = client.getQueryCache().find({ queryKey: ['auth'], exact: true })
      // Confirm a shared failure through the existing session read. A broken resource alone stays local.
      if (!auth?.isActive() || auth.state.error || auth.state.fetchStatus !== 'idle') return
      probing = true
      void client.refetchQueries({ queryKey: ['auth'], exact: true }, { cancelRefetch: false }).finally(() => { probing = false })
    } }),
  })
  return client
}
