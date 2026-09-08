import { readFileSync } from 'node:fs'
import { BACKGROUND_PRESETS } from '../../../packages/protocol/src/backgrounds.ts'

// The build copies the reviewed assets next to the bundled server. Paths come only from this catalog.
const images = new Map(BACKGROUND_PRESETS.map(image => [image.id, {
  content: readFileSync(new URL(`./backgrounds/${image.slug}.webp`, import.meta.url)),
  thumbnail: readFileSync(new URL(`./backgrounds/${image.slug}.thumb.webp`, import.meta.url)),
}]))

export function builtinBackgroundContent(id: string, thumbnail: boolean) {
  const image = images.get(id)
  return image && (thumbnail ? image.thumbnail : image.content)
}
