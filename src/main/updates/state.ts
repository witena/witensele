/**
 * The update status as a pure reducer (S7.4).
 *
 * Everything that decides what Settings → About says and when the notice bar
 * appears is here, in one function of `(status, event, now)`. Nothing in this
 * file imports electron, `electron-updater` or a timer — the library's events
 * arrive as the normalised `UpdateEvent` union from `@shared/updates`, which is
 * what lets a fake drive the whole walk in a unit test (`state.test.ts`).
 *
 * The two rules that are not obvious from the state names, and that exist
 * because the app checks again every six hours:
 *
 * 1. **`downloaded` is terminal.** A periodic check that runs after an update has
 *    already been downloaded must not move the state back to `checking` or
 *    `up-to-date`: the downloaded bundle is still installable, the notice bar
 *    still has something true to offer, and a bar that vanished on its own would
 *    strand the user one restart away from a version they cannot reach any more.
 *    Only a `downloaded` event for a *different* version replaces it.
 * 2. **`unsupported` is terminal too.** A build that cannot install an update is
 *    not made able to by anything the feed says. The service does not even
 *    subscribe in that case, so this is a belt on top of braces — but it is the
 *    invariant the UI relies on when it shows the reason instead of the button.
 */
import type { UpdateEvent, UpdateStatus } from '@shared/updates'

/** Clamps a reported percentage into 0–100 and rounds it to a whole number. */
function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.round(percent)))
}

/**
 * Applies one updater event to the status.
 *
 * `now` is injected rather than read from `Date.now()` so a test can assert
 * `checkedAt` exactly; the service passes its own clock.
 */
export function reduceUpdate(
  status: UpdateStatus,
  event: UpdateEvent,
  now: () => number = Date.now
): UpdateStatus {
  // Rule 2: nothing reaches a build that cannot install anything.
  if (status.state === 'unsupported') return status

  // Rule 1: a finished download outlives every later check.
  if (status.state === 'downloaded' && !(event.kind === 'downloaded' && event.version !== status.version)) {
    return status
  }

  switch (event.kind) {
    case 'checking':
      // The version of a previous check is dropped: it is about to be restated
      // or contradicted, and showing last week's number while asking is a lie
      // with a spinner next to it.
      return { state: 'checking' }

    case 'available':
      return { state: 'available', version: event.version, checkedAt: now() }

    case 'not-available':
      return { state: 'up-to-date', checkedAt: now() }

    case 'progress': {
      // `electron-updater` reports progress without a version, so the one the
      // `available` event named is carried forward. A progress tick that arrives
      // first (no check of ours started it — a resumed download) still produces a
      // correct bar, just without a number beside it.
      const version = event.version ?? status.version
      return {
        state: 'downloading',
        ...(version !== undefined ? { version } : {}),
        percent: clampPercent(event.percent),
        ...(status.checkedAt !== undefined ? { checkedAt: status.checkedAt } : {})
      }
    }

    case 'downloaded':
      return {
        state: 'downloaded',
        version: event.version,
        percent: 100,
        ...(status.checkedAt !== undefined ? { checkedAt: status.checkedAt } : {})
      }

    case 'error':
      // The version is kept: "0.2.0 was found and then the download failed" is a
      // more useful screen than "something failed".
      return {
        state: 'error',
        ...(status.version !== undefined ? { version: status.version } : {}),
        error: event.message,
        checkedAt: now()
      }
  }
}
