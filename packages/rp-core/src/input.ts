import { requireValue } from './errors.ts'
import type { JsonObject } from './types.ts'

/** Shared input guards stay independent of asset import and server-only processing. */
export function objectInput(value: unknown): asserts value is JsonObject {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST', '请提供完整的资料内容。')
}
