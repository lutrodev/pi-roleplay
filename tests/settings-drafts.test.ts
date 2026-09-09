import { expect, it } from 'vitest'
import { DEFAULT_PREFERENCES, normalizePreferences } from '../packages/rp-core/src/settings/preferences.ts'
import { mergeSection, sectionChanged } from '../apps/web/src/pages/settings/preference-drafts.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { SettingsService } from '../apps/server/src/services/settings-service.ts'
import { fixture } from './helpers.ts'

it('saves one category without applying or discarding drafts in another category', () => {
  const stored = structuredClone(DEFAULT_PREFERENCES), draft = structuredClone(stored)
  draft.reading.fontSize = 21; draft.identity = 'Unfinished identity'; draft.quickReplies = [{ id: 'draft', label: '', content: '', cursorPosition: 'end' }]
  const saved = mergeSection(stored, draft, 'reading'), remaining = mergeSection(draft, saved, 'reading')
  expect(saved.reading.fontSize).toBe(21); expect(saved.identity).toBe(stored.identity); expect(saved.quickReplies).toEqual(stored.quickReplies)
  expect(sectionChanged(saved, remaining, 'reading')).toBe(false)
  expect(sectionChanged(saved, remaining, 'prompts')).toBe(true)
  expect(sectionChanged(saved, remaining, 'quick-replies')).toBe(true)
  const discarded = mergeSection(remaining, saved, 'prompts')
  expect(discarded.identity).toBe(stored.identity); expect(discarded.quickReplies[0]?.label).toBe('')
})

it.each(['quick-replies', 'reply-options'] as const)('saves %s independently while retaining an unfinished draft in the other reply category', group => {
  const stored = structuredClone(DEFAULT_PREFERENCES), draft = structuredClone(stored)
  const other = group === 'quick-replies' ? 'reply-options' : 'quick-replies'
  draft.quickReplies = [{ id: 'draft', label: group === 'quick-replies' ? '记笔记' : '', content: '我记下新的线索。', cursorPosition: 'end' }]
  draft.quickRepliesEnabled = false; draft.replyOptionsEnabled = false
  draft.replyOptions = { count: 2, maxCharacters: group === 'reply-options' ? 40 : 0, keywords: ['调查', '交谈'] }
  // An invalid draft in the other category must not enter this save request.
  const saved = normalizePreferences(mergeSection(stored, draft, group))
  expect(saved.quickReplies).toEqual(group === 'quick-replies' ? draft.quickReplies : stored.quickReplies)
  expect(saved.replyOptions).toEqual(group === 'reply-options' ? draft.replyOptions : stored.replyOptions)
  expect(saved.quickRepliesEnabled).toBe(group !== 'quick-replies')
  expect(saved.replyOptionsEnabled).toBe(group !== 'reply-options')
  const remaining = mergeSection(draft, saved, group)
  expect(sectionChanged(saved, remaining, group)).toBe(false)
  expect(sectionChanged(saved, remaining, other)).toBe(true)
  expect(remaining.quickReplies).toEqual(draft.quickReplies)
  expect(remaining.replyOptions).toEqual(draft.replyOptions)
  // Discarding the unfinished category leaves the independently saved category intact.
  expect(mergeSection(remaining, saved, other)).toEqual(saved)
})

it('keeps the latest default model when saving or discarding another category', () => {
  const stored = { ...structuredClone(DEFAULT_PREFERENCES), mainModel: { provider: 'current', model: 'new-default' } }
  const draft = { ...structuredClone(stored), identity: 'draft' }
  expect(mergeSection(stored, draft, 'prompts').mainModel).toEqual(stored.mainModel)
  expect(mergeSection(draft, stored, 'prompts').mainModel).toEqual(stored.mainModel)
})

it('saves display preferences together without consuming optional-behavior drafts', () => {
  const stored = structuredClone(DEFAULT_PREFERENCES), draft = structuredClone(stored)
  draft.reading = { ...draft.reading, dialogueHighlight: false, dialogueColor: 'blue', italicHighlight: false, italicColor: 'indigo', showAvatars: false, showStateCard: false }
  draft.subagentsEnabled = false
  const saved = normalizePreferences(mergeSection(stored, draft, 'reading'))
  expect(saved.reading).toEqual(draft.reading)
  expect(saved.subagentsEnabled).toBe(true)
  expect(sectionChanged(saved, draft, 'reading')).toBe(false)
  expect(sectionChanged(saved, draft, 'subagents')).toBe(true)
  const discarded = mergeSection(draft, stored, 'reading')
  expect(discarded.reading).toEqual(stored.reading)
  expect(discarded.subagentsEnabled).toBe(false)
})

it('allows unrelated preferences to save after model removal, while rejecting new unavailable selections', () => {
  const x = fixture(), route = { provider: 'test', model: 'model' }
  try {
    const models = new ModelRegistry([{ ...route, api: 'openai-completions', baseUrl: 'https://synthetic.invalid/v1', keyEnv: 'TEST', contextWindow: 128000, maxTokens: 8192 }], { env: () => 'synthetic' })
    const settings = new SettingsService(x.assets, models), first = settings.snapshot()
    const selected = settings.update(first.revision, { ...first.preferences, mainModel: route }); models.replace([])
    const saved = settings.update(selected.revision, { ...selected.preferences, language: 'en' })
    expect(saved.preferences.mainModel).toEqual(route); expect(saved.preferences.language).toBe('en')
    expect(() => settings.update(saved.revision, { ...saved.preferences, mainModel: { ...route, model: 'other' } })).toThrow()
    expect(settings.update(saved.revision, { ...saved.preferences, mainModel: null }).preferences.mainModel).toBeNull()
  } finally { x.close() }
})
