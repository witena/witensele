/**
 * What the app knows about its own next version (S7.4).
 *
 * Shared, because all three processes read it: the main process produces it, the
 * preload bridge carries it and the renderer draws it in Settings → About and in
 * the notice bar. It is deliberately a small, JSON-serializable record rather
 * than an `electron-updater` type — nothing outside `src/main/ipc/updater.ts`
 * should know which library is behind the feed, and a server build that offers no
 * updates at all still has to be able to answer `system.updateStatus`.
 */

/**
 * The states an update can be in.
 *
 * The happy path is `idle → checking → available → downloading → downloaded`;
 * a check that finds nothing ends in `up-to-date` and a check that fails ends in
 * `error`. `unsupported` is not part of that walk at all: it is the answer of a
 * build that cannot install an update whatever the feed says, and no event moves
 * out of it (see `reduceUpdate`).
 */
export const UPDATE_STATES = [
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'up-to-date',
  'error',
  'unsupported'
] as const

export type UpdateState = (typeof UPDATE_STATES)[number]

/**
 * Why this build cannot update itself.
 *
 * Both answers are shown to the user, because "Check for updates" doing nothing
 * with no explanation is worse than no button at all:
 *
 * - `unsigned` — the bundle carries no Developer ID signature (S7.3's
 *   `witenaSignedBuild`). macOS refuses to replace a signed app with an unsigned
 *   one and `electron-updater` verifies the downloaded bundle against the running
 *   one before swapping it, so an unsigned build can download an update and never
 *   install it. The honest UI is "download the new release yourself".
 * - `development` — the app is running from a checkout (`npm run dev`, the
 *   end-to-end harness) rather than from a bundle. There is nothing to replace.
 */
export const UNSUPPORTED_REASONS = ['unsigned', 'development'] as const

export type UnsupportedReason = (typeof UNSUPPORTED_REASONS)[number]

/** Everything `system.updateStatus` answers with. */
export interface UpdateStatus {
  state: UpdateState
  /**
   * The version the feed offers, once a check has found one. Present from
   * `available` onwards and kept across `downloading` / `downloaded`.
   */
  version?: string
  /** Download progress, 0–100, rounded. Present only while `downloading`. */
  percent?: number
  /**
   * Developer-facing detail of a failed check, shown verbatim under the button.
   *
   * It is **not** an i18n key: the text comes from the updater or from the
   * network and there is no fixed set of them to translate. The sentence around
   * it is a key (`settings.about.updates.error`), which is the same call
   * `notices.providerError` already makes.
   */
  error?: string
  /** Present exactly when `state === 'unsupported'`. */
  reason?: UnsupportedReason
  /** Epoch milliseconds of the last check that finished, however it ended. */
  checkedAt?: number
}

/** The status of a build that has never checked. */
export const IDLE_UPDATE_STATUS: UpdateStatus = { state: 'idle' }

/** How often a running app asks the feed, per S7.4: six hours. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * One thing the updater reported, normalised away from `electron-updater`'s
 * event names.
 *
 * This union is the seam: `src/main/ipc/updater.ts` translates the library's six
 * events into it and the fake in `src/main/updates/service.test.ts` produces it
 * directly, so the state machine is exercised without electron anywhere near it.
 */
export type UpdateEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number; version?: string }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }
