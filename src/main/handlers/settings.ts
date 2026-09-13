/**
 * `settings.*` — application settings, one JSON row per user.
 *
 * The merge rules (defaults underneath a read, `timeouts` merged field by field
 * on a write) live in `src/main/db/repositories/settings.ts`; the handlers only
 * validate the payload and scope the call to `ctx.userId`.
 */
import { THEME_SETTINGS, type AppSettingsPatch, type ThemeSetting } from '@shared/types'
import { validation } from '../errors'
import type { HandlerModule } from './types'

/**
 * Accepts only the three documented keys; anything else is a client bug.
 *
 * `theme` is the one value whose *content* is checked as well (S5.8). It is
 * worth the three lines because it is the only setting that is read back by code
 * which cannot fail safely: a stored `'sepia'` would reach `resolveTheme`, resolve
 * to light, and leave a user staring at a theme nothing in the UI can explain.
 * The language is not checked the same way because `resolveLanguage` falls back
 * to English for anything it does not know, which is a visible, recoverable
 * state rather than a silent one.
 */
function assertPatch(patch: unknown): asserts patch is AppSettingsPatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw validation('settings.update requires a patch object')
  }
  const allowed = new Set(['language', 'theme', 'timeouts'])
  const unknownKeys = Object.keys(patch).filter((key) => !allowed.has(key))
  if (unknownKeys.length > 0) {
    throw validation(`settings.update received unknown keys: ${unknownKeys.join(', ')}`)
  }
  const theme = (patch as AppSettingsPatch).theme
  if (theme !== undefined && !THEME_SETTINGS.includes(theme as ThemeSetting)) {
    throw validation(
      `settings.update received an unknown theme: ${String(theme)} (expected ${THEME_SETTINGS.join(', ')})`
    )
  }
}

export const settingsHandlers: HandlerModule = {
  'settings.get': async (ctx) => ctx.repos.settings.get(ctx.userId),

  'settings.update': async (ctx, input) => {
    assertPatch(input?.patch)
    return ctx.repos.settings.update(input.patch, ctx.userId)
  }
}
