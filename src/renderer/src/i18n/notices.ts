/**
 * Rendering backend-authored notices.
 *
 * The main process never produces a sentence: a `system-notice` part carries an
 * i18n key plus parameters (see `SystemNoticePart` in `src/shared/types.ts`),
 * because the backend does not know the UI language and because a stored message
 * would otherwise be frozen in whatever language was active when it was written.
 * This module is the renderer half of that contract.
 */
import type { SystemNoticePart } from '@shared/types'

/**
 * The subset of i18next's `t` this module needs.
 *
 * Declaring the shape instead of importing `TFunction` keeps the helper testable
 * with a two-line fake and keeps `SystemNoticePart` free of any i18next types.
 */
export type TranslateFn = (key: string, params: Record<string, unknown>) => string

/** Notice keys live under this prefix in the locale files. */
export const NOTICE_PREFIX = 'notices.'

/**
 * Translates one `system-notice` part.
 *
 * An unknown key falls back to the raw key rather than an empty string or a
 * thrown error: a notice the renderer has no copy for is a missing translation,
 * not a reason to break the message list, and the raw key is what a bug report
 * needs to see.
 */
export function translateNotice(t: TranslateFn, part: SystemNoticePart): string {
  const params = { ...part.params, defaultValue: '' }
  const translated = t(NOTICE_PREFIX + part.key, params)
  return translated.length > 0 ? translated : part.key
}
