/**
 * i18next setup for the renderer.
 *
 * Design notes worth knowing before touching this file:
 *
 * - **The resources are bundled, not fetched.** Both locale files are imported
 *   statically, so `init` completes synchronously (i18next only defers when a
 *   backend connector has to load a namespace). That is what lets the bootstrap
 *   in `main.tsx` render the tree immediately after calling `initI18n`, with no
 *   flash of raw keys and no loading state to design around.
 * - **One namespace.** Everything lives in the default `translation` namespace
 *   and the "namespaces" from the plan (`common`, `nav`, `chat`, …) are simply
 *   the top level of the key tree, so a key is always `t('chat.send')`. Splitting
 *   into real i18next namespaces would buy lazy loading we do not need.
 * - **Language vs. setting.** `AppSettings.language` may be `'system'`, which is
 *   not a language i18next can be set to. `resolveLanguage` is the single place
 *   that turns the stored setting into one of `SUPPORTED_LANGUAGES`.
 */
import i18next, { type i18n as I18nInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { Language } from '@shared/types'
import en from '../locales/en.json'
import zhCN from '../locales/zh-CN.json'

/** Every language the UI ships. The order is the order the switcher shows them in. */
export const SUPPORTED_LANGUAGES = ['zh-CN', 'en'] as const satisfies readonly Language[]

/** Used when a key is missing from the active language, and for unknown settings. */
export const FALLBACK_LANGUAGE: Language = 'en'

/**
 * Turns the stored setting into an actual UI language.
 *
 * `'system'` follows the browser/OS language: anything that starts with `zh`
 * (`zh`, `zh-CN`, `zh-Hans`, `zh-TW`, …) maps to Simplified Chinese, everything
 * else falls back to English. Traditional Chinese is deliberately folded into
 * `zh-CN` for now — a separate `zh-TW` locale is a future step, and until it
 * exists a Traditional Chinese system is better served by Chinese than by
 * English.
 */
export function resolveLanguage(setting: Language | 'system', navigatorLanguage: string): Language {
  if (setting !== 'system') return setting
  return navigatorLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : FALLBACK_LANGUAGE
}

/**
 * The language the host environment reports.
 *
 * Kept here rather than read inline in the store so that nothing outside this
 * module has to know the setting is resolved against a browser global. Tests
 * stub it with `vi.stubGlobal('navigator', …)`.
 */
export function getNavigatorLanguage(): string {
  return globalThis.navigator?.language ?? FALLBACK_LANGUAGE
}

/**
 * Initialises the shared i18next instance and returns it.
 *
 * Idempotent: calling it again only switches the language. React StrictMode and
 * unit tests both re-enter bootstrap code, and a second `init()` would otherwise
 * rebuild the whole instance under the components already using it.
 */
export function initI18n(initial: Language): I18nInstance {
  if (i18next.isInitialized) {
    if (i18next.language !== initial) void i18next.changeLanguage(initial)
    return i18next
  }

  void i18next.use(initReactI18next).init({
    lng: initial,
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    resources: {
      en: { translation: en },
      'zh-CN': { translation: zhCN }
    },
    interpolation: {
      // React escapes everything it renders already; escaping here would turn
      // an apostrophe in an agent name into `&#39;` on screen.
      escapeValue: false
    }
  })

  return i18next
}

/** The shared instance. Only meaningful after `initI18n` has run. */
export const i18n: I18nInstance = i18next
