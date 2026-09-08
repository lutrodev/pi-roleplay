import { findDialogueRanges } from '../../../../packages/rp-core/src/display/dialogue-ranges.js'

export interface ProseNode {
  type: string
  value?: string
  children?: ProseNode[]
  data?: { hName: string; hProperties: Record<string, string> }
}

/** Match rendered inline prose across emphasis, without coloring links, code or HTML. */
export function dialoguePlugin() {
  return (tree: ProseNode) => {
    const visit = (node: ProseNode) => {
      if (!node.children) return
      if (!['paragraph', 'heading', 'tableCell'].includes(node.type)) { node.children.forEach(visit); return }
      let text = ''
      const offsets = new Map<ProseNode, number>()
      const collect = (child: ProseNode) => {
        if (['inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'html'].includes(child.type)) { text += '\0'; return }
        if (child.type === 'text') { offsets.set(child, text.length); text += child.value ?? '' }
        else if (child.type === 'break') text += '\n'
        else child.children?.forEach(collect)
      }
      collect(node)
      const ranges = findDialogueRanges(text) as { start: number; end: number }[]
      const color = (parent: ProseNode) => {
        if (!parent.children) return
        parent.children = parent.children.flatMap(child => {
          const offset = offsets.get(child)
          if (offset === undefined) { color(child); return [child] }
          const value = child.value ?? '', parts: ProseNode[] = []
          let cursor = 0
          for (const range of ranges) {
            const start = Math.max(cursor, range.start - offset, 0), end = Math.min(value.length, range.end - offset)
            if (end <= start) continue
            if (start > cursor) parts.push({ type: 'text', value: value.slice(cursor, start) })
            parts.push({ type: 'rpDialogue', data: { hName: 'span', hProperties: { className: 'dialogue' } }, children: [{ type: 'text', value: value.slice(start, end) }] })
            cursor = end
          }
          if (cursor < value.length) parts.push({ type: 'text', value: value.slice(cursor) })
          return parts
        })
      }
      color(node)
    }
    visit(tree)
  }
}
