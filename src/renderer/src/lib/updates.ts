/**
 * The one sentence Settings → About prints under "Updates" (S7.4).
 *
 * A `switch` whose arms each spell their key out, rather than one call over a
 * key built from the state name — the reason `sectionLabel` in
 * `pages/settings-page.tsx` gives. A key assembled at runtime is invisible to
 * `i18n/used-keys.test.ts`, so a state whose copy nobody wrote would ship as a
 * raw key on screen. Written out, the guard checks all eight of them, and the
 * compiler checks that all eight are written out.
 *
 * It lives in `lib/` rather than beside the component because it is pure and has
 * its own unit test; `t` is declared structurally so that test needs no i18next.
 */
import type { UnsupportedReason, UpdateStatus } from '@shared/updates'

/**
 * The subset of i18next's `t` this module uses; see `i18n/notices.ts`.
 *
 * `params` is required rather than optional for the same reason it is there: an
 * optional second argument is not assignable to i18next's own overloaded `t`
 * under `exactOptionalPropertyTypes`, so every call passes an object, empty when
 * the sentence takes nothing.
 */
export type TranslateFn = (key: string, params: Record<string, unknown>) => string

/**
 * The status as one line of prose.
 *
 * `version` is interpolated as the empty string when the backend has not named
 * one yet, which can only happen for a `downloading` that no check of ours
 * started — a download resumed from a previous launch.
 */
export function updateStateLabel(t: TranslateFn, status: UpdateStatus): string {
  const version = status.version ?? ''

  switch (status.state) {
    case 'idle':
      return t('settings.about.updates.idle', {})
    case 'checking':
      return t('settings.about.updates.checking', {})
    case 'available':
      return t('settings.about.updates.available', { version })
    case 'downloading':
      return t('settings.about.updates.downloading', { version, percent: status.percent ?? 0 })
    case 'downloaded':
      return t('settings.about.updates.downloaded', { version })
    case 'up-to-date':
      return t('settings.about.updates.upToDate', {})
    case 'error':
      return t('settings.about.updates.error', { message: status.error ?? '' })
    case 'unsupported':
      return unsupportedLabel(t, status.reason)
  }
}

/**
 * Why this build cannot update itself.
 *
 * An absent reason is treated as `development`, which is the harmless half of
 * the pair: it says "this is not a released build" rather than accusing a
 * perfectly good bundle of being unsigned.
 */
export function unsupportedLabel(t: TranslateFn, reason: UnsupportedReason | undefined): string {
  return reason === 'unsigned'
    ? t('settings.about.updates.unsignedBuild', {})
    : t('settings.about.updates.developmentBuild', {})
}

/**
 * Whether "Check for updates" can be pressed.
 *
 * Disabled while a check or a download is running — a second click would join
 * the first anyway (`UpdateService.check`) and a button that looks live while
 * doing nothing is worse than one that is visibly busy — and on a build that has
 * nothing to check.
 */
export function canCheckForUpdates(status: UpdateStatus, checking: boolean): boolean {
  if (checking) return false
  return status.state !== 'unsupported' && status.state !== 'checking' && status.state !== 'downloading'
}
