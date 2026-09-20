/**
 * Application settings: one JSON row per user.
 *
 * Reads merge the stored object over `DEFAULT_APP_SETTINGS`, so a user who has
 * never opened the settings page gets the defaults, and a setting added in a
 * later version appears with its default value without a migration. Writes are a
 * shallow merge, except `timeouts`, `editor` and `mcpEndpoint`, which merge
 * field by field so a caller can change `toolTimeoutMs` — or the editor's
 * `kind` — without resending the rest of the group.
 *
 * The nested groups are merged on the **read** side as well, and that is not
 * belt and braces: a row written by an older version has no `editor` at all, and
 * a row written by a newer one may have half of it, so the `...stored` spread
 * would otherwise hand out an `editor` with no `command` in it. The same read
 * merge is what keeps `mcpEndpoint.enabled` `false` for every installation that
 * predates S10.3.
 */
import { eq } from 'drizzle-orm'
import type { AppSettings, AppSettingsPatch, UserId } from '@shared/types'
import { DEFAULT_APP_SETTINGS, LOCAL_USER_ID } from '@shared/types'
import type { DrizzleDb } from '../database'
import { settings } from '../schema'
import { now } from './common'

export interface SettingsRepository {
  /** Never throws: an absent row means "everything is still default". */
  get(userId?: UserId): AppSettings
  update(patch: AppSettingsPatch, userId?: UserId): AppSettings
}

function withDefaults(stored: Partial<AppSettings> | undefined): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    ...stored,
    editor: { ...DEFAULT_APP_SETTINGS.editor, ...stored?.editor },
    // Every row written before S10.3 has no `mcpEndpoint` at all, and the
    // default is `{ enabled: false }` — so an installation that updates into
    // this version does *not* silently open a local port.
    mcpEndpoint: { ...DEFAULT_APP_SETTINGS.mcpEndpoint, ...stored?.mcpEndpoint },
    timeouts: { ...DEFAULT_APP_SETTINGS.timeouts, ...stored?.timeouts }
  }
}

export function createSettingsRepository(db: DrizzleDb): SettingsRepository {
  function read(userId: UserId): AppSettings {
    const row = db.select().from(settings).where(eq(settings.userId, userId)).get()
    return withDefaults(row?.data)
  }

  return {
    get(userId = LOCAL_USER_ID) {
      return read(userId)
    },

    update(patch, userId = LOCAL_USER_ID) {
      const current = read(userId)
      const next: AppSettings = {
        ...current,
        ...(patch.language !== undefined ? { language: patch.language } : {}),
        ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
        ...(patch.onboardingDismissed !== undefined
          ? { onboardingDismissed: patch.onboardingDismissed }
          : {}),
        editor: { ...current.editor, ...patch.editor },
        mcpEndpoint: { ...current.mcpEndpoint, ...patch.mcpEndpoint },
        timeouts: { ...current.timeouts, ...patch.timeouts }
      }
      const timestamp = now()
      db.insert(settings)
        .values({ userId, data: next, updatedAt: timestamp })
        .onConflictDoUpdate({
          target: settings.userId,
          set: { data: next, updatedAt: timestamp }
        })
        .run()
      return next
    }
  }
}
