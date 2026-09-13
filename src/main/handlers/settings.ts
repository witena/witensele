/**
 * `settings.*` — application settings, one JSON row per user.
 *
 * The merge rules (defaults underneath a read, `timeouts` merged field by field
 * on a write) live in `src/main/db/repositories/settings.ts`; the handlers only
 * validate the payload and scope the call to `ctx.userId`.
 */
import type { AppSettingsPatch } from '@shared/types'
import { validation } from '../errors'
import type { HandlerModule } from './types'

/** Accepts only the three documented keys; anything else is a client bug. */
function assertPatch(patch: unknown): asserts patch is AppSettingsPatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw validation('settings.update requires a patch object')
  }
  const allowed = new Set(['language', 'theme', 'timeouts'])
  const unknownKeys = Object.keys(patch).filter((key) => !allowed.has(key))
  if (unknownKeys.length > 0) {
    throw validation(`settings.update received unknown keys: ${unknownKeys.join(', ')}`)
  }
}

export const settingsHandlers: HandlerModule = {
  'settings.get': async (ctx) => ctx.repos.settings.get(ctx.userId),

  'settings.update': async (ctx, input) => {
    assertPatch(input?.patch)
    return ctx.repos.settings.update(input.patch, ctx.userId)
  }
}
