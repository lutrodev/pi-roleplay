import { afterEach, expect, it } from 'vitest'
import { setUiLanguage, uiLanguage, uiLocale, uiT } from '../apps/web/src/lib/i18n.ts'
import english from '../apps/web/src/locales/en.json'
import englishErrors from '../apps/web/src/locales/en-errors.json'
import englishWriterHistory from '../apps/web/src/locales/en-writer-history.json'
import englishModelServices from '../apps/web/src/locales/en-model-services.json'
import englishComposer from '../apps/web/src/locales/en-composer.json'

afterEach(() => setUiLanguage('zh'))

it('switches authored interface labels and distinguishes closing a dialog from disabling reasoning', () => {
  setUiLanguage('en')
  expect(uiLanguage()).toBe('en')
  expect(uiLocale()).toBe('en-US')
  expect(uiT('设置')).toBe('Settings')
  expect(uiT('角色卡')).toBe('Character cards')
  expect(uiT('关闭')).toBe('Close')
  expect(uiT('关闭', { context: 'reasoning' })).toBe('Off')
  expect(uiT('密码不正确。')).toBe('Incorrect password.')
  setUiLanguage('zh')
  expect(uiLocale()).toBe('zh-CN')
  expect(uiT('关闭', { context: 'reasoning' })).toBe('关闭')
  expect(uiT('设置')).toBe('设置')
})

it('interpolates counts and user names literally without translating data or consuming RP macros', () => {
  setUiLanguage('en')
  const name = '设置 {{model}} %{index} <section> & $t(设置)'
  expect(uiT('第 %{index} 组', { index: 7 })).toBe('Group 7')
  expect(uiT('%{v0}实际发送内容', { v0: name })).toContain(name)
  expect(uiT('系统设置；留空时不额外插入身份；{{model}} 展开为接收方模型')).toContain('{{model}}')
  expect(uiT('未知诊断原文')).toBe('未知诊断原文')
})

it('preserves every interpolation field in the English catalog', () => {
  const fields = (text: string) => [...text.matchAll(/%\{([^}]+)\}/g)].map(match => match[1]).sort()
  for (const [source, translated] of Object.entries({ ...english, ...englishErrors, ...englishWriterHistory, ...englishModelServices, ...englishComposer })) {
    expect(translated.trim(), source).not.toBe('')
    expect(fields(translated), source).toEqual(fields(source))
  }
})
