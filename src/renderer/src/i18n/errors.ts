/**
 * `BackendErrorCode` → the sentence the user reads.
 *
 * The backend never sends UI copy: a rejected call carries a machine-readable
 * `code` plus a developer-facing `message` (see `BackendError` in
 * `@shared/types`), and picking the words is the renderer's job — the same
 * contract `notices.ts` implements for stored system messages.
 *
 * Written as a `switch` of **literal** `t()` calls rather than a
 * `Record<BackendErrorCode, string>` lookup for two reasons, both of which the
 * shell already learned the hard way: `t(KEYS[code])` is invisible to
 * `used-keys.test.ts`, so a typo would ship; and a `switch` with no `default`
 * makes the compiler prove the mapping is total when a new code is added.
 */
import type { BackendError, BackendErrorCode } from '@shared/types'

/** The subset of i18next's `t` this module needs; keeps it testable with a stub. */
export type TranslateFn = (key: string) => string

/** The translated sentence for one failure class. Total over `BackendErrorCode`. */
export function errorMessage(t: TranslateFn, code: BackendErrorCode): string {
  switch (code) {
    case 'not_found':
      return t('errors.not_found')
    case 'validation':
      return t('errors.validation')
    case 'provider_error':
      return t('errors.provider_error')
    case 'mcp_error':
      return t('errors.mcp_error')
    case 'aborted':
      return t('errors.aborted')
    case 'unauthorized':
      return t('errors.unauthorized')
    case 'internal':
      return t('errors.internal')
  }
}

/**
 * The same for a whole `BackendError`, which is what a caller usually holds.
 *
 * `error.message` is deliberately *not* used: it is provider or driver text in
 * whatever language that system speaks, and it belongs in the dimmed detail line
 * next to this sentence, never in place of it.
 */
export function translateError(t: TranslateFn, error: BackendError): string {
  return errorMessage(t, error.code)
}
