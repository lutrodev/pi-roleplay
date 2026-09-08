import { requireValue } from '../errors.ts'

export const MAX_STATE_NAMESPACES = 32

export function requireStateNamespaceCapacity(count: number) {
  requireValue(count <= MAX_STATE_NAMESPACES, 'STATE_NAMESPACE_LIMIT', `变量组最多 ${MAX_STATE_NAMESPACES} 个，请先删除不再使用的变量组。`)
}
