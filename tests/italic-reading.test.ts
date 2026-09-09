import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES, ITALIC_COLORS } from '../packages/rp-core/src/settings/preferences.ts'
import { SettingsService } from '../apps/server/src/services/settings-service.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { AssetRepository } from '../apps/server/src/storage/asset-repository.ts'
import { ReadingControls } from '../apps/web/src/components/reading-controls.tsx'
import { ITALIC_PALETTE } from '../apps/web/src/lib/reading-colors.ts'
import { fixture, message, profile } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => { for (const x of fixtures.splice(0)) x.close() })
function setup() {
  const x = fixture(), models = new ModelRegistry([])
  fixtures.push(x)
  return { ...x, models, settings: new SettingsService(x.assets, models) }
}
function v8Preferences() {
  const { italicHighlight: _enabled, italicColor: _color, ...reading } = DEFAULT_PREFERENCES.reading
  return { ...structuredClone(DEFAULT_PREFERENCES), reading }
}

describe('independent italic preferences', () => {
  it('upgrades v8 once without reapplying retired story feature migration, and survives database reopen', () => {
    const x = setup(), story = x.stories.create('斜体升级', profile())
    x.stories.append(story.id, { type: 'message.added', data: { message: message('assistant', '*灯塔...还亮着。 *她想。') } })
    const before = x.stories.snapshot(story.id), events = x.stories.eventLog(story.id)
    const old = v8Preferences()
    old.reading = { ...old.reading, theme: 'dark', fontFamily: 'serif', fontSize: 22, dialogueHighlight: false, dialogueColor: 'rose', showAvatars: false }
    x.assets.setSetting('app.preferences', JSON.parse(JSON.stringify({ version: 8, revision: 31, preferences: old })))
    const upgraded = x.settings.snapshot()
    expect(upgraded).toEqual({ version: 9, revision: 32, preferences: { ...old, reading: { ...old.reading, italicHighlight: true, italicColor: 'teal' } } })
    expect(x.settings.snapshot()).toEqual(upgraded)
    expect(x.stories.snapshot(story.id)).toEqual(before)
    expect(x.stories.eventLog(story.id)).toEqual(events)
    expect(() => x.settings.update(31, upgraded.preferences)).toThrow('已经更新')
    x.database.close()
    const reopened = new AppDatabase(x.filename)
    try { expect(new SettingsService(new AssetRepository(reopened), x.models).snapshot()).toEqual(upgraded) }
    finally { reopened.close() }
  })

  it('does not overwrite corrupt v8 data while migrating', () => {
    const x = setup(), old = v8Preferences()
    for (const reading of [{ ...old.reading, italicColor: 'rose' }, { ...old.reading, dialogueHighlight: 'false' }, { ...old.reading, fontSize: null }]) {
      const stored = JSON.parse(JSON.stringify({ version: 8, revision: 7, preferences: { ...old, reading } }))
      x.assets.setSetting('app.preferences', stored)
      expect(() => x.settings.snapshot()).toThrow('设置已损坏')
      expect(x.assets.getSetting('app.preferences')).toEqual(stored)
    }
  })

  it('persists each italic color and all switch combinations independently of dialogue', () => {
    const x = setup()
    let saved = x.settings.snapshot()
    for (const italicColor of ITALIC_COLORS) for (const italicHighlight of [true, false]) for (const dialogueHighlight of [true, false]) {
      saved = x.settings.update(saved.revision, { ...saved.preferences, reading: { ...saved.preferences.reading, italicColor, italicHighlight, dialogueHighlight } })
      expect(saved.preferences.reading).toMatchObject({ italicColor, italicHighlight, dialogueHighlight, dialogueColor: 'orange' })
      expect(new SettingsService(x.assets, x.models).snapshot()).toEqual(saved)
    }
    for (const invalid of [{ italicColor: 'orange' }, { italicColor: '#00aaaa' }, { italicColor: null }, { italicHighlight: 'false' }, { italicHighlight: null }]) {
      expect(() => x.settings.update(saved.revision, { ...saved.preferences, reading: { ...saved.preferences.reading, ...invalid } })).toThrow()
      expect(x.settings.snapshot()).toEqual(saved)
    }
  })
})

describe('reading preview', () => {
  it.each([true, false])('shows italic styling and independent color selection with highlighting %s', italicHighlight => {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(ReadingControls, {
      value: { ...DEFAULT_PREFERENCES.reading, dialogueHighlight: !italicHighlight, italicHighlight, italicColor: 'indigo' }, onChange() {},
    })))
    expect(html).toContain('<em>她在心里松了一口气。</em>')
    expect(html).toContain(`--italic-light:${ITALIC_PALETTE.indigo.light}`)
    expect(html).toContain(`--italic-ink:${italicHighlight ? 'var(--italic)' : 'initial'}`)
    expect(html).toMatch(/<input\b(?=[^>]*value="indigo")(?=[^>]*checked="")[^>]*>/)
    const fieldsets = [...html.matchAll(/<fieldset class="highlight-color-options"[^>]*>/g)].map(match => match[0])
    expect(fieldsets).toHaveLength(2)
    expect(fieldsets[0]?.includes('disabled')).toBe(italicHighlight)
    expect(fieldsets[1]?.includes('disabled')).toBe(!italicHighlight)
    expect(html.includes('class="dialogue"')).toBe(!italicHighlight)
  })
})
