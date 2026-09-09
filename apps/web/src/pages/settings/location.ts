export const settingsSections = ['models', 'reading', 'quick-replies', 'reply-options', 'prompts', 'skills', 'subagents', 'writer-history', 'tools', 'status'] as const
export type SettingsSection = typeof settingsSections[number]

export function settingsSearch(search: Record<string, unknown>): { section?: SettingsSection } {
  return typeof search.section === 'string' && settingsSections.includes(search.section as SettingsSection)
    ? { section: search.section as SettingsSection }
    : {}
}
