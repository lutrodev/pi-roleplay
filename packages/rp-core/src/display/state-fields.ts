import type { JsonObject, JsonValue } from '../types.ts'

export interface StateField { path: string; title: string; description?: string; value: JsonValue | undefined }
export function stateFields(value: JsonValue | undefined, schema: JsonObject = {}, path = '', title = ''): StateField[] {
  if (value !== null && typeof value === 'object') {
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties as JsonObject : {}
    const keys = [...new Set([...Object.keys(properties).filter(key => Object.hasOwn(value, key)), ...Object.keys(value)])]
    if (keys.length) return keys.flatMap(key => {
      const child = (Array.isArray(value) ? schema.items : properties[key]) as JsonObject | undefined
      const label = typeof child?.title === 'string' ? child.title : key
      return stateFields((value as Record<string, JsonValue>)[key], child ?? {}, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, title ? `${title} · ${label}` : label)
    })
  }
  return [{ path: path || '', title: title || String(schema.title ?? '值'), ...(typeof schema.description === 'string' ? { description: schema.description } : {}), value }]
}
