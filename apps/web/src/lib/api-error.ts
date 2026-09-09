export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly details?: unknown) { super(message) }
}

/** Only shared infrastructure failures can be covered by a connection notice. */
export function connectionFailure(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  if (error.status === 0) return 'network'
  if (error.code === 'INVALID_RESPONSE') return 'response'
  if (error.status >= 500) return 'service'
  if (error.status === 429) return 'rate-limit'
  return null
}

export function sameConnectionFailure(error: unknown, shared: unknown) {
  const kind = connectionFailure(error)
  return kind !== null && kind === connectionFailure(shared)
}
