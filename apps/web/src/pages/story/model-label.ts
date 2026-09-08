/** Drop a display-label suffix only when the leading name identifies the same model. */
export function compactModelLabel(model: { label: string; model: string; provider: string }): string {
  const [name, ...qualifiers] = model.label.split(/\s+·\s+/u)
  if (!name || !qualifiers.length) return model.label
  const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const id = model.model.split('/').at(-1)!
  return normalized(name) === normalized(id) || normalized(qualifiers.join(' ')) === normalized(model.provider) ? name : model.label
}
