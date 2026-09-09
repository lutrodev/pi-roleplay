import { legacyPreferences } from './legacy-preferences.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES, DIALOGUE_COLORS } from '../packages/rp-core/src/settings/preferences.ts'
import { SettingsService } from '../apps/server/src/services/settings-service.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { DIALOGUE_PALETTE, ITALIC_PALETTE } from '../apps/web/src/lib/reading-colors.ts'
import { ReadingControls } from '../apps/web/src/components/reading-controls.tsx'
import { Markdown } from '../apps/web/src/components/markdown.tsx'
import { fixture } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => { for (const item of fixtures.splice(0)) item.close() })
function setup() {
  const x = fixture(), models = new ModelRegistry([])
  fixtures.push(x)
  return { ...x, models, settings: new SettingsService(x.assets, models) }
}

describe('dialogue preferences', () => {
  it.each([true, false])('upgrades v5 once while retaining the dialogue switch (%s) and other preferences', enabled => {
    const x = setup(), preferences = { ...structuredClone(DEFAULT_PREFERENCES), identity: '原有偏好', reading: { ...DEFAULT_PREFERENCES.reading, fontSize: 22, dialogueHighlight: enabled, theme: 'dark' as const, fontFamily: 'serif' as const } }
    const { dialogueColor: _color, ...reading } = preferences.reading
    x.assets.setSetting('app.preferences', JSON.parse(JSON.stringify({ version: 5, revision: 40, preferences: legacyPreferences(preferences, 5) })))
    const upgraded = x.settings.snapshot()
    expect(upgraded).toEqual({ version: 9, revision: 41, preferences: { ...preferences, reading: { ...preferences.reading, dialogueColor: 'green' } } })
    expect(new SettingsService(x.assets, x.models).snapshot()).toEqual(upgraded)
    expect(x.assets.getSetting('app.preferences')).toEqual(upgraded)
    expect(() => x.settings.update(40, upgraded.preferences)).toThrow('已经更新')
  })

  it('defaults to visible orange dialogue and persists validated colors without changing the switch', () => {
    const x = setup()
    let saved = x.settings.snapshot()
    expect(saved.preferences.reading.dialogueHighlight).toBe(true)
    expect(saved.preferences.reading.dialogueColor).toBe('orange')
    for (const dialogueColor of DIALOGUE_COLORS) {
      saved = x.settings.update(saved.revision, { ...saved.preferences, reading: { ...saved.preferences.reading, dialogueColor } })
      expect(new SettingsService(x.assets, x.models).snapshot()).toEqual(saved)
    }
    saved = x.settings.update(saved.revision, { ...saved.preferences, reading: { ...saved.preferences.reading, dialogueHighlight: false } })
    expect(saved.preferences.reading.dialogueColor).toBe('rose')
    for (const dialogueColor of ['#ff8800', 'unknown', '', null, 1]) {
      expect(() => x.settings.update(saved.revision, { ...saved.preferences, reading: { ...saved.preferences.reading, dialogueColor } })).toThrow('高亮颜色')
      expect(x.settings.snapshot()).toEqual(saved)
    }
  })
})

describe('quoted conversation text', () => {
  it('colors smart and straight quotes with emphasis while leaving surrounding narration unchanged', () => {
    const text = '“还在营业吗？”她问。\n\n他说："还有**一杯**。" 然后点头。\n\n「等一下。」『好。』'
    const html = renderToStaticMarkup(createElement(Markdown, { text, highlight: true }))
    expect(html).toContain('<span class="dialogue">“还在营业吗？”</span>她问。')
    expect(html).toContain('<strong><span class="dialogue">一杯</span></strong>')
    expect(html).toContain('<span class="dialogue">「等一下。」</span><span class="dialogue">『好。』</span>')
    expect(renderToStaticMarkup(createElement(Markdown, { text, highlight: false }))).not.toContain('class="dialogue"')
  })

  it('uses the real renderer and selected color in the preview, and respects the switch', () => {
    const render = (highlight: boolean) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(ReadingControls, {
      value: { ...DEFAULT_PREFERENCES.reading, theme: 'dark', dialogueColor: 'orange', dialogueHighlight: highlight },
      onChange() {},
    })))
    const enabled = render(true)
    expect(enabled).toContain('<span class="dialogue">“你终于来了。”</span>她说。')
    expect(enabled).toContain('data-preview-theme="dark"')
    expect(enabled).toContain(`--dialogue-dark:${DIALOGUE_PALETTE.orange.dark}`)
    expect(enabled).toMatch(/<input\b(?=[^>]*value="orange")(?=[^>]*checked="")[^>]*>/)
    const disabled = render(false)
    expect(disabled).not.toContain('class="dialogue"')
    expect(disabled).toContain('class="highlight-color-options" disabled=""')
  })
})

const luminance = (hex: string) => {
  const channels = hex.slice(1).match(/../g)!.map(channel => {
    const value = parseInt(channel, 16) / 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  })
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722
}
it('keeps every preset legible on light and dark conversation and preview surfaces', () => {
  const backgrounds = { light: ['#ffffff', '#fcfcfc', '#f6f6f7', '#f0f0f2'], dark: ['#19191b', '#232326', '#2d2d32'] }
  for (const [color, palette] of Object.entries({ ...DIALOGUE_PALETTE, ...ITALIC_PALETTE })) for (const theme of ['light', 'dark'] as const) {
    for (const surface of backgrounds[theme]) {
      const foreground = luminance(palette[theme]), background = luminance(surface)
      const ratio = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)
      expect(ratio, `${color} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  }
})
