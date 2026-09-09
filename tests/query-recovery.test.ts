import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from '../apps/web/src/lib/api-error.ts'
import { createQueryClient, recoverFailedReads } from '../apps/web/src/lib/query-client.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop() })
function client(shared = false) {
  const value = shared ? createQueryClient() : new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  cleanup.push(() => value.clear())
  return value
}
function observe<T>(client: QueryClient, key: string, queryFn: () => Promise<T>) {
  const observer = new QueryObserver(client, { queryKey: [key], queryFn, staleTime: Infinity })
  cleanup.push(observer.subscribe(() => {}))
  return observer
}
const network = () => new ApiError('Connection interrupted', 'NETWORK_ERROR', 0)

describe('shared connection recovery', () => {
  it('recovers active failed reads once, preserving business failures and never replaying writes or inactive queries', async () => {
    const cache = client(), calls = { queue: 0, denied: 0, inactive: 0, write: 0 }
    let offline = true
    const queue = observe(cache, 'queue', async () => { calls.queue++; if (offline) throw network(); return ['pending'] })
    const denied = observe(cache, 'denied', async () => { calls.denied++; throw new ApiError('Permission denied', 'DENIED', 403) })
    await cache.fetchQuery({ queryKey: ['inactive'], queryFn: async () => { calls.inactive++; throw network() } }).catch(() => {})
    await cache.getMutationCache().build(cache, { mutationFn: async () => { calls.write++; throw network() } }).execute(undefined).catch(() => {})
    await expect.poll(() => [queue.getCurrentResult().status, denied.getCurrentResult().status]).toEqual(['error', 'error'])
    offline = false
    const first = recoverFailedReads(cache), second = recoverFailedReads(cache)
    expect(second).toBe(first)
    await first
    expect(queue.getCurrentResult().data).toEqual(['pending'])
    expect(denied.getCurrentResult().error).toMatchObject({ status: 403 })
    expect(calls).toEqual({ queue: 2, denied: 1, inactive: 1, write: 1 })
  })

  it('uses one existing session read to confirm simultaneous failures, without recursively probing a failed session', async () => {
    const cache = client(true)
    let authCalls = 0, offline = false
    const auth = observe(cache, 'auth', async () => { authCalls++; if (offline) throw network(); return { authenticated: true } })
    await expect.poll(() => auth.getCurrentResult().isSuccess).toBe(true)
    offline = true
    const stories = observe(cache, 'stories', async () => { throw network() })
    const queue = observe(cache, 'queue', async () => { throw network() })
    await expect.poll(() => auth.getCurrentResult().isError).toBe(true)
    expect(authCalls).toBe(2)
    await Promise.all([stories.refetch(), queue.refetch()])
    expect(authCalls).toBe(2)
  })

  it('keeps a single resource outage local when the session is healthy and does not probe again during read recovery', async () => {
    const cache = client(true)
    let authCalls = 0, resourceCalls = 0
    const auth = observe(cache, 'auth', async () => { authCalls++; return { authenticated: true } })
    await expect.poll(() => auth.getCurrentResult().isSuccess).toBe(true)
    const resource = observe(cache, 'resource', async () => { resourceCalls++; throw new ApiError('Resource service unavailable', 'HTTP_ERROR', 503) })
    await expect.poll(() => authCalls).toBe(2)
    await recoverFailedReads(cache)
    expect(resource.getCurrentResult().isError).toBe(true)
    expect(auth.getCurrentResult().error).toBeNull()
    expect(authCalls).toBe(2)
    expect(resourceCalls).toBe(2)
  })
})
