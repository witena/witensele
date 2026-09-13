/**
 * Application settings — the first zustand store in the app, and the reference
 * for the ones that follow.
 *
 * Shape of every store here:
 *
 * - The backend owns the data. `settings` mirrors what `settings.get` returned
 *   and is replaced by whatever `settings.update` answers with; the optimistic
 *   write in `setLanguage` exists only so the switch feels instant, and is
 *   overwritten by the authoritative response a moment later.
 * - The store reaches the backend through `getBackend()`, never through
 *   `window.witena` (CLAUDE.md rule #6), so `settings.test.ts` can drive it with
 *   a fake client in plain Node.
 * - `status` is explicit rather than derived from `settings === null`, because
 *   "not loaded yet" and "load failed" need different UI.
 */
import { create } from 'zustand'
import type { AppSettings, AppTimeouts, ThemeSetting } from '@shared/types'
import { getNavigatorLanguage, i18n, resolveLanguage } from '../i18n'
import { getBackend } from '../lib/backend-provider'
import { activateTheme } from '../lib/theme'

/** The stored setting: a concrete language, or "follow the system". */
export type LanguageSetting = AppSettings['language']

export type SettingsStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SettingsState {
  /** Backend-owned mirror of the settings row; `null` until the first load. */
  settings: AppSettings | null
  status: SettingsStatus
  /** Developer-facing detail of a failed load; the UI shows `common.error`. */
  error?: string | undefined

  /** Reads the settings row. Never rejects: failures land in `status` / `error`. */
  load: () => Promise<void>
  /** Persists the language setting and applies it to i18next immediately. */
  setLanguage: (language: LanguageSetting) => Promise<void>
  /**
   * Persists the appearance setting, repaints the window and tells the main
   * process, which owns the parts of the window the renderer cannot paint: the
   * traffic lights and the native dialogs (`system.applyTheme`).
   */
  setTheme: (theme: ThemeSetting) => Promise<void>
  /**
   * Persists one or more heartbeat budgets.
   *
   * A **partial** of `AppTimeouts`, because the backend merges `timeouts` field
   * by field: the Timeouts section writes one field per control, so a value the
   * user changed a moment earlier in another field is never overwritten by a
   * stale copy of the whole object.
   */
  setTimeouts: (patch: Partial<AppTimeouts>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: null,
  status: 'idle',
  error: undefined,

  async load() {
    set({ status: 'loading', error: undefined })
    try {
      const settings = await getBackend().invoke('settings.get')
      set({ settings, status: 'ready', error: undefined })
    } catch (cause) {
      // The bootstrap must still render — a broken settings row cannot be a
      // blank window — so the failure is state, not an exception.
      set({ status: 'error', error: cause instanceof Error ? cause.message : String(cause) })
    }
  },

  async setLanguage(language) {
    const previous = get().settings
    // Optimistic: the radio group must not lag a round trip behind the click.
    if (previous) set({ settings: { ...previous, language } })

    const settings = await getBackend().invoke('settings.update', { patch: { language } })
    set({ settings, status: 'ready', error: undefined })

    await i18n.changeLanguage(resolveLanguage(settings.language, getNavigatorLanguage()))
  },

  async setTheme(theme) {
    const previous = get().settings
    // Optimistic for the same reason as the language, and then some: the click
    // repaints the entire window, so a round trip of delay would look broken.
    if (previous) set({ settings: { ...previous, theme } })
    activateTheme(theme)

    const settings = await getBackend().invoke('settings.update', { patch: { theme } })
    set({ settings, status: 'ready', error: undefined })

    // The authoritative answer may differ from the optimistic write (another
    // window, a rejected value), so the attribute is stamped from it as well.
    activateTheme(settings.theme)
    // Best effort: the window chrome following the theme is a nicety, and a
    // transport that cannot do it (a server build) must not fail the setting.
    await getBackend()
      .invoke('system.applyTheme', { theme: settings.theme })
      .catch(() => undefined)
  },

  async setTimeouts(patch) {
    const settings = await getBackend().invoke('settings.update', { patch: { timeouts: patch } })
    set({ settings, status: 'ready', error: undefined })
  }
}))

/**
 * The stored setting, which is what the language switcher highlights.
 *
 * Note this is *not* the active i18next language: `'system'` is a valid setting
 * and resolves to `zh-CN` or `en`. Components that need the active language read
 * `i18n.language` from `useTranslation()`.
 */
export function useLanguage(): LanguageSetting {
  return useSettingsStore((state) => state.settings?.language ?? 'system')
}
