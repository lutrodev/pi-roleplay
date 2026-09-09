import { DEFAULT_PREFERENCES, type Preferences } from '../packages/rp-core/src/settings/preferences.ts'

export const LEGACY_FEATURE_IDS = ['character-card', 'lore-book', 'persona', 'preset', 'writing-style', 'state', 'compat-mvu', 'subagent-manager', 'quick-replies', 'reply-options', 'message-actions', 'state-display', 'message-avatar', 'dialogue-highlight']

/** Persisted pre-v8 document shape, kept as input fixtures for upgrade/recovery tests only. */
export function legacyPreferences(preferences: Preferences = structuredClone(DEFAULT_PREFERENCES), version = 7) {
  const { quickRepliesEnabled, replyOptionsEnabled, subagentsEnabled, reading: currentReading, ...fields } = preferences
  const { dialogueHighlight, showAvatars, showStateCard, italicHighlight: _italicHighlight, italicColor: _italicColor, ...reading } = currentReading
  const switches: Record<string, boolean> = { 'quick-replies': quickRepliesEnabled, 'reply-options': replyOptionsEnabled, 'subagent-manager': subagentsEnabled, 'dialogue-highlight': dialogueHighlight, 'message-avatar': showAvatars, 'state-display': showStateCard }
  const value = { ...fields, enabledFeatures: LEGACY_FEATURE_IDS.filter(id => switches[id] !== false), reading }
  if (version < 6) delete (value.reading as Partial<typeof reading>).dialogueColor
  if (version < 5) delete (value.reading as Partial<typeof reading>).fontFamily
  if (version < 4) delete (value as Partial<typeof value>).language
  if (version < 3) delete (value as Partial<typeof value>).busyEnter
  if (version < 2) delete (value as Partial<typeof value>).transcriptView
  return value
}
