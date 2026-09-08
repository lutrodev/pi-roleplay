import type { Preferences } from '../../../../../packages/rp-core/src/settings/preferences.ts'

export const preferenceGroups = {
  reading: ['language', 'transcriptView', 'busyEnter', 'reading'],
  subagents: ['subagentsEnabled'],
  'quick-replies': ['quickRepliesEnabled', 'quickReplies'],
  'reply-options': ['replyOptionsEnabled', 'replyOptions'],
  prompts: ['identity'],
  skills: ['skills', 'disabledSkills'],
} satisfies Record<string, (keyof Preferences)[]>
export type PreferenceGroup = keyof typeof preferenceGroups
export function sectionChanged(stored: Preferences, draft: Preferences, group: PreferenceGroup) {
  return JSON.stringify(stored) !== JSON.stringify(mergeSection(stored, draft, group))
}
export function mergeSection(base: Preferences, source: Preferences, group: PreferenceGroup): Preferences {
  const result = { ...base, ...Object.fromEntries(preferenceGroups[group].map(key => [key, structuredClone(source[key])])) }
  return result
}
