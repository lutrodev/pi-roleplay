export const MAX_BACKGROUNDS = 24
export const MAX_BACKGROUND_UPLOAD_BYTES = 10 * 1024 * 1024
export const BACKGROUND_INTENSITY = { min: 5, max: 40, default: 18 } as const

export interface BackgroundImage {
  id: string
  name: string
  width: number
  height: number
  size: number
  createdAt: string
}
export interface BackgroundChoice { selectedId: string | null; intensity: number }
export interface BackgroundSnapshot extends BackgroundChoice { revision: number; images: BackgroundImage[] }

export interface BackgroundPreset extends Pick<BackgroundImage, 'id' | 'name' | 'width' | 'height'> { slug: string; description: string }
/** Stable IDs keep saved selections valid across deployments and database restores. */
export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  { id: 'b118e38b-43a6-4a9e-9892-ed9378f5a7e8', slug: 'lantern-tavern', name: '炉火酒馆', description: '暖光 · 室内', width: 1672, height: 941 },
  { id: '6282ddf2-4d5a-4d92-a8b5-0d8c6bc7a9ea', slug: 'misty-highlands', name: '雾野远山', description: '晨雾 · 山野', width: 1672, height: 941 },
  { id: '6fa79013-b0bf-4130-a644-61048d7c8f4a', slug: 'rainy-harbor', name: '雨夜归港', description: '蓝调 · 海港', width: 1672, height: 941 },
]
export function findBackground(snapshot: BackgroundSnapshot | undefined, id: string | null | undefined) {
  return BACKGROUND_PRESETS.find(image => image.id === id) ?? snapshot?.images.find(image => image.id === id)
}
