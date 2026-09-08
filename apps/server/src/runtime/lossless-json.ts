/** Node 24 source access preserves every numeric lexeme until the final JSON.stringify. */
export function losslessObject(source: string): Record<string, unknown> {
  const nativeJson = JSON as unknown as {
    parse(source: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown): Record<string, unknown>
    rawJSON(source: string): unknown
  }
  return nativeJson.parse(source, (_key, value, context) => typeof value === 'number' && context.source ? nativeJson.rawJSON(context.source) : value)
}
