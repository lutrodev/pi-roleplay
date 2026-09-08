interface Node { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Node[] }

/** Highlight literal text after Markdown is parsed, including code, without interpreting query HTML. */
export function searchPlugin({ query }: { query: string }) {
  const needle = query.toLocaleLowerCase()
  return (root: Node) => {
    if (!needle) return
    const visit = (node: Node) => {
      if (!node.children || node.tagName === 'mark') return
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { visit(child); return [child] }
        const text = child.value, lower = text.toLocaleLowerCase(), parts: Node[] = []
        let start = 0, index = lower.indexOf(needle)
        while (index >= 0) {
          if (index > start) parts.push({ type: 'text', value: text.slice(start, index) })
          parts.push({ type: 'element', tagName: 'mark', properties: {}, children: [{ type: 'text', value: text.slice(index, index + query.length) }] })
          start = index + query.length; index = lower.indexOf(needle, start)
        }
        if (start < text.length) parts.push({ type: 'text', value: text.slice(start) })
        return parts
      })
    }
    visit(root)
  }
}
