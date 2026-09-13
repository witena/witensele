/**
 * Application settings: one JSON row per user.
 *
 * Reads merge the stored object over `DEFAULT_APP_SETTINGS`, so a user who has
 * never opened the settings page gets the defaults, and a setting added in a
 * later version appears with its default value without a migration. Writes are a
 * shallow merge, except `timeouts`, which merges field by field so a caller can
 * change `toolTimeoutMs` without resending the other two.
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
