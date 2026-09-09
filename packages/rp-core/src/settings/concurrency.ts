import { objectInput } from '../input.ts'
import { requireValue } from '../errors.ts'

export interface ConcurrencySettings { maxRequests: number; maxRequestsPerConnection: number }
export const DEFAULT_CONCURRENCY: ConcurrencySettings = { maxRequests: 4, maxRequestsPerConnection: 2 }
export function normalizeConcurrency(input: unknown): ConcurrencySettings {
  objectInput(input)
  requireValue(Object.keys(input).sort().join(',') === 'maxRequests,maxRequestsPerConnection', 'INVALID_CONCURRENCY', '请提交完整的并发设置。')
  for (const key of ['maxRequests', 'maxRequestsPerConnection'] as const) {
    requireValue(Number.isSafeInteger(input[key]) && Number(input[key]) >= 1 && Number(input[key]) <= 32, 'INVALID_CONCURRENCY', '并发请求数必须是 1 到 32 之间的整数。')
  }
  return { maxRequests: Number(input.maxRequests), maxRequestsPerConnection: Number(input.maxRequestsPerConnection) }
}
