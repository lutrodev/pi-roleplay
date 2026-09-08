import { createInstance } from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import english from '../locales/en.json'
import englishErrors from '../locales/en-errors.json'
import englishWriterHistory from '../locales/en-writer-history.json'
import englishModelServices from '../locales/en-model-services.json'
import englishComposer from '../locales/en-composer.json'

export type UiLanguage = 'zh' | 'en'
const preferenceKey = 'rp-ui-language'
function initialLanguage(): UiLanguage {
  try { return localStorage.getItem(preferenceKey) === 'en' ? 'en' : 'zh' } catch { return 'zh' }
}

/** Only authored interface copy is translated. Story text, prompts and imported assets remain data. */
export const uiI18n = createInstance()
const englishCopy = { ...english, ...englishErrors, ...englishWriterHistory, ...englishModelServices, ...englishComposer }
void uiI18n.use(initReactI18next).init({
  lng: initialLanguage(), fallbackLng: 'zh', supportedLngs: ['zh', 'en'], initAsync: false,
  defaultNS: 'ui', keySeparator: false, nsSeparator: false,
  resources: { en: { ui: englishCopy }, zh: { ui: { ...Object.fromEntries(Object.keys(englishCopy).map(key => [key, key])), '关闭_reasoning': '关闭' } } },
  interpolation: { escapeValue: false, prefix: '%{', suffix: '}' },
})

export function uiT(text: string, values?: Record<string, string | number>) {
  return uiI18n.t(text, { ...values, defaultValue: text, returnObjects: false })
}
export function uiLanguage(): UiLanguage { return uiI18n.resolvedLanguage === 'en' ? 'en' : 'zh' }
export function uiLocale() { return uiLanguage() === 'en' ? 'en-US' : 'zh-CN' }
/** Subscribe every interface component that formats translated copy, without remounting its draft or focus. */
export function useUiLanguage() { useTranslation('ui', { i18n: uiI18n }); return uiLanguage() }
export function setUiLanguage(language: UiLanguage) { if (uiI18n.language !== language) void uiI18n.changeLanguage(language) }
function rememberLanguage() {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = uiLanguage() === 'en' ? 'en' : 'zh-CN'
    document.title = uiT('pi-roleplay · 创作工作台')
    document.querySelector('meta[name="description"]')?.setAttribute('content', uiT('属于你的故事与角色。'))
  }
  try { localStorage.setItem(preferenceKey, uiLanguage()) } catch { /* Server settings remain authoritative. */ }
}
uiI18n.on('languageChanged', rememberLanguage)
rememberLanguage()
