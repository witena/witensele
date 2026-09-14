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
 *
 * S5.2 added a second, narrower layer for the same reason it exists at all. The
 * seven codes are coarse, and "the request was rejected as invalid" is the right
 * answer almost everywhere because the control that sent the request is on
 * screen saying what it wanted — but not when the user picked a folder that is
 * not a folder, or added a member the chat cannot hold. Those refusals carry a
 * `ValidationReason` identifier in `BackendError.details`, and
 * `validationReasonMessage` translates it with the same literal-`switch`
 * discipline.
 *
 * S5.10 added nine more, all of them narrowing one request the Goal block sent:
 * which field of the goal was wrong, and — for a path — whether the problem is
 * that it is absolute or that it leaves the folder. Those two are separate
 * reasons because they are corrected differently.
 *
 * S5.3 used both halves, and the line between them is the one to keep: the two
 * refusals of the provider form (`oauth_unsupported_provider`,
 * `oauth_custom_base_url`) are reasons, because they narrow the refusal of one
 * request — while `ant_missing` and `ant_not_logged_in` are codes, because they
 * describe the state of a tool on the user's machine and are raised while
 * building a model for a chat turn as well as while validating a form. S5.13
 * added the Google three on the same side of that line: `gcloud_missing`,
 * `gcloud_not_logged_in` and `gcloud_no_project` are all facts about the
 * machine's Google Cloud SDK, and the third of them is raised by the fetch
 * wrapper mid-request, which is nobody's form.
 *
 * S7.6 added `key_unreadable` on the same side again: a key encrypted by a
 * previous installation is a fact about this machine's stored data, and it is
 * raised while resolving a provider for a chat turn as well as while probing one
 * from the settings form.
 */
import type { BackendError, BackendErrorCode, ValidationReason } from '@shared/types'
import { VALIDATION_REASONS } from '@shared/types'

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
    case 'ant_missing':
      return t('errors.ant_missing')
    case 'ant_not_logged_in':
      return t('errors.ant_not_logged_in')
    case 'gcloud_missing':
      return t('errors.gcloud_missing')
    case 'gcloud_not_logged_in':
      return t('errors.gcloud_not_logged_in')
    case 'gcloud_no_project':
      return t('errors.gcloud_no_project')
    case 'key_unreadable':
      return t('errors.key_unreadable')
  }
}

/**
 * The narrower sentence for one `validation` refusal the renderer names
 * precisely. Total over `ValidationReason`, for the reason above.
 */
export function validationReasonMessage(t: TranslateFn, reason: ValidationReason): string {
  switch (reason) {
    case 'workdir_not_absolute':
      return t('errors.workdir_not_absolute')
    case 'workdir_missing':
      return t('errors.workdir_missing')
    case 'workdir_not_directory':
      return t('errors.workdir_not_directory')
    case 'second_executor':
      return t('errors.second_executor')
    case 'oauth_unsupported_provider':
      return t('errors.oauth_unsupported_provider')
    case 'oauth_custom_base_url':
      return t('errors.oauth_custom_base_url')
    case 'handoff_no_workdir':
      return t('errors.handoff_no_workdir')
    case 'handoff_no_executor':
      return t('errors.handoff_no_executor')
    case 'handoff_run_active':
      return t('errors.handoff_run_active')
    case 'handoff_no_deliverable':
      return t('errors.handoff_no_deliverable')
    case 'editor_path_not_absolute':
      return t('errors.editor_path_not_absolute')
    case 'editor_path_outside_workdir':
      return t('errors.editor_path_outside_workdir')
    case 'goal_description_empty':
      return t('errors.goal_description_empty')
    case 'goal_description_too_long':
      return t('errors.goal_description_too_long')
    case 'goal_deliverable_required':
      return t('errors.goal_deliverable_required')
    case 'goal_deliverable_not_relative':
      return t('errors.goal_deliverable_not_relative')
    case 'goal_deliverable_outside_workdir':
      return t('errors.goal_deliverable_outside_workdir')
    case 'goal_material_not_relative':
      return t('errors.goal_material_not_relative')
    case 'goal_material_outside_workdir':
      return t('errors.goal_material_outside_workdir')
    case 'goal_material_missing':
      return t('errors.goal_material_missing')
    case 'goal_needs_workdir':
      return t('errors.goal_needs_workdir')
  }
}

/**
 * The `ValidationReason` carried in a `BackendError`'s `details`, if any.
 *
 * `details` is `unknown` by contract — it is whatever the failing handler
 * attached — so this narrows rather than casts, and an unrecognised value is
 * simply "no reason", which falls back to the sentence for the code. A renderer
 * running against a newer backend therefore degrades to the generic copy instead
 * of printing a raw identifier.
 */
export function validationReasonOf(details: unknown): ValidationReason | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const reason = (details as { reason?: unknown }).reason
  return VALIDATION_REASONS.find((known) => known === reason)
}

/**
 * The sentence for a failure a store kept as its two (or three) separate halves.
 *
 * Stores hold `errorCode` plus the developer-facing `error` message, and since
 * S5.2 also `errorDetails`; this is the one place that turns that trio into copy,
 * so a component never has to rebuild a `BackendError` literal in JSX.
 */
export function translateFailure(
  t: TranslateFn,
  code: BackendErrorCode | undefined,
  details?: unknown
): string {
  const reason = validationReasonOf(details)
  // A reason only narrows `validation`: an id that turned up in a `not_found`'s
  // details says nothing about why the request was refused.
  if (code === 'validation' && reason) return validationReasonMessage(t, reason)
  return errorMessage(t, code ?? 'internal')
}

/**
 * The same for a whole `BackendError`, which is what a caller usually holds.
 *
 * `error.message` is deliberately *not* used: it is provider or driver text in
 * whatever language that system speaks, and it belongs in the dimmed detail line
 * next to this sentence, never in place of it. `error.details` *is* used, but
 * only for the identifier in it (see `validationReasonOf`).
 */
export function translateError(t: TranslateFn, error: BackendError): string {
  return translateFailure(t, error.code, error.details)
}
