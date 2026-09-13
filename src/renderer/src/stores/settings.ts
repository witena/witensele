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
import type { AppSettings } from '@shared/types'
import { getNavigatorLanguage, i18n, resolveLanguage } from '../i18n'
import { getBackend } from '../lib/backend-provider'

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
