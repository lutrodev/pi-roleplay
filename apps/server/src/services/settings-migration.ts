import { objectInput } from '../../../../packages/rp-core/src/input.ts'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import { DEFAULT_PREFERENCES, normalizePreferences } from '../../../../packages/rp-core/src/settings/preferences.ts'
import type { StoryProfile } from '../../../../packages/rp-core/src/types.ts'
import { StoryRepository } from '../storage/story-repository.ts'
import type { AppDatabase } from '../storage/database.ts'

// Retired global gates are accepted only while upgrading persisted settings.
const legacyFeatures = ['character-card', 'lore-book', 'persona', 'preset', 'writing-style', 'state', 'compat-mvu', 'subagent-manager', 'quick-replies', 'reply-options', 'message-actions', 'state-display', 'message-avatar', 'dialogue-highlight']
const dependencies: Record<string, string[]> = { 'compat-mvu': ['character-card', 'lore-book', 'state'], 'state-display': ['state'] }

export function upgradePreferences(input: unknown, version: number) {
  objectInput(input)
  objectInput(input.reading)
  const { italicColor, italicHighlight } = DEFAULT_PREFERENCES.reading
  if (version === 8) {
    requireValue(Object.keys(input.reading).sort().join(',') === 'dialogueColor,dialogueHighlight,fontFamily,fontSize,lineHeight,maxWidth,showAvatars,showStateCard,theme', 'INVALID_SETTINGS', '旧阅读设置格式不正确。')
    return { preferences: normalizePreferences({ ...input, reading: { ...input.reading, italicColor, italicHighlight } }), features: null }
  }
  const keys = ['mainModel', 'enabledFeatures', 'skills', 'disabledSkills', 'identity', 'quickReplies', 'replyOptions', 'reading',
    ...(version >= 2 ? ['transcriptView'] : []), ...(version >= 3 ? ['busyEnter'] : []), ...(version >= 4 ? ['language'] : [])]
  requireValue(Object.keys(input).sort().join(',') === keys.sort().join(','), 'INVALID_SETTINGS', '旧设置格式不正确。')
  requireValue(Object.keys(input.reading).every(key => ['theme', 'fontFamily', 'fontSize', 'lineHeight', 'maxWidth', ...(version >= 6 ? ['dialogueColor'] : [])].includes(key)), 'INVALID_SETTINGS', '旧阅读设置包含未知字段。')
  const oldFeatures = input.enabledFeatures
  requireValue(Array.isArray(oldFeatures) && new Set(oldFeatures).size === oldFeatures.length && oldFeatures.every(id => typeof id === 'string' && (legacyFeatures.includes(id) || version < 7 && id === 'compact-access-mode')), 'INVALID_SETTINGS', '旧功能设置包含未知项或重复项。')
  const features = oldFeatures as string[]
  for (const id of features) requireValue((dependencies[id] ?? []).every(required => features.includes(required)), 'INVALID_SETTINGS', '旧功能设置缺少前置功能。')
  requireValue(version >= 6 || !Object.hasOwn(input.reading, 'dialogueColor'), 'INVALID_SETTINGS', '旧阅读设置格式不正确。')
  const { enabledFeatures: _retired, ...fields } = input
  const preferences = normalizePreferences({ ...fields,
    ...(version === 1 ? { transcriptView: 'compact' } : {}), ...(version < 3 ? { busyEnter: 'queue' } : {}), ...(version < 4 ? { language: 'zh' } : {}),
    quickRepliesEnabled: features.includes('quick-replies'), replyOptionsEnabled: features.includes('reply-options'), subagentsEnabled: features.includes('subagent-manager'),
    reading: { ...(version < 5 ? { fontFamily: 'sans' } : {}), ...input.reading, ...(version < 6 ? { dialogueColor: 'green' } : {}),
      dialogueHighlight: features.includes('dialogue-highlight'), showAvatars: features.includes('message-avatar'), showStateCard: features.includes('state-display'), italicColor, italicHighlight },
  })
  return { preferences, features }
}

/** Append the effective selections to each story; never rewrite history or erase shared assets/state. Called in the settings transaction. */
export function migrateStoryFeatures(database: AppDatabase, features: string[]) {
  const stories = new StoryRepository(database)
  const rows = database.sqlite.prepare('SELECT id FROM stories ORDER BY id').all() as { id: string }[]
  for (const { id } of rows) {
    const story = stories.snapshot(id), profile: StoryProfile = structuredClone(story.profile)
    if (!features.includes('character-card')) {
      delete profile.resources.card
      if (profile.scene.openingSource === 'card') {
        const openingText = story.messages.find(message => message.kind === 'opening')?.text ?? profile.scene.openingText
        profile.scene = { ...profile.scene, openingSource: openingText ? 'custom' : 'skip', ...(openingText ? { openingText } : {}) }
        delete profile.scene.openingIndex
      }
    }
    if (!features.includes('persona')) delete profile.resources.persona
    if (!features.includes('preset')) delete profile.resources.preset
    if (!features.includes('lore-book')) profile.resources.lorebooks = []
    if (!features.includes('writing-style')) profile.resources.writingStyles = []
    const variables = { enabled: features.includes('state'), mvu: features.includes('compat-mvu') }
    if (!variables.enabled || !variables.mvu) profile.variables = variables
    if (JSON.stringify(profile) === JSON.stringify(story.profile)) continue
    profile.revision += 1
    stories.append(id, { type: 'profile.changed', data: { profile } }, 'settings-v8:story-selections')
  }
}
