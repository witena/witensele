/**
 * The updater, as the rest of the backend sees it (S7.4).
 *
 * `electron-updater` is electron — it reads `app.getVersion()`, the bundle's
 * `app-update.yml` and the code signature of what it downloaded — so it may only
 * be imported from `src/main/index.ts` or `src/main/ipc/` (CLAUDE.md rule #5).
 * This file is the Electron-free half: it owns the status, the six-hour
 * schedule, the `update.available` / `update.downloaded` events and the refusal
 * that an unsigned build has to give, and it reaches the library through the
 * injected `Updater` port below. `src/main/ipc/updater.ts` is the only
 * implementation of that port that touches the library; `service.test.ts` drives
 * the same walk with twenty lines of fake.
 *
 * Why injection rather than the `handlers/system.ts` + `src/main/ipc/` overlay
 * that `system.applyTheme` uses (S5.8): the theme call is a one-line
 * notification with no state behind it, so an overlay costs nothing. The updater
 * has a cached status, a periodic timer and two emitted events, and every one of
 * those is behaviour a test has to be able to reach. Putting them in the electron
 * layer would put them where no unit test can go.
 */
import type { BackendEvent } from '@shared/events'
import {
  IDLE_UPDATE_STATUS,
  UPDATE_CHECK_INTERVAL_MS,
  type UnsupportedReason,
  type UpdateEvent,
  type UpdateStatus
} from '@shared/updates'
import { BackendFailure } from '../errors'
import { reduceUpdate } from './state'

/**
 * The capability the service needs from whatever is behind the feed.
 *
 * Three methods, because that is all `electron-updater` is used for once
 * `autoDownload` is on: subscribe, ask, and swap the bundle. Everything else —
 * when to ask, what the answer means, who is told — is this file's job.
 */
export interface Updater {
  /** Normalised updater events. Returns the unsubscribe function. */
  subscribe(listener: (event: UpdateEvent) => void): () => void
  /**
   * Asks the feed once. Resolves when the *check* is done, not when the download
   * is: the download reports itself through `progress` and `downloaded`.
   */
  check(): Promise<void>
  /**
   * Quits the app and relaunches into the downloaded version. It does not
   * return, which is why it is `void` and why the handler that calls it answers
   * before the process is gone.
   */
  install(): void
}

export interface UpdateServiceOptions {
  /**
   * The real updater, or `null` when this build cannot update itself — an
   * unsigned bundle or a checkout. `reason` then says which.
   */
  updater: Updater | null
  reason?: UnsupportedReason
  /** Where `update.available` and `update.downloaded` go. */
  emit: (event: BackendEvent) => void
  /** Overridable so a test does not wait six hours. */
  intervalMs?: number
  /** Injected clock, for `checkedAt`. */
  now?: () => number
}

/**
 * The message `system.installUpdate` refuses with when nothing has been
 * downloaded yet.
 *
 * Exported so the handler test can assert on it rather than on a sentence
 * spelled twice.
 */
export const NOTHING_TO_INSTALL = 'No update has been downloaded, so there is nothing to install'

export class UpdateService {
  private status: UpdateStatus
  private readonly updater: Updater | null
  private readonly emit: (event: BackendEvent) => void
  private readonly intervalMs: number
  private readonly now: () => number
  private unsubscribe: (() => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** The in-flight check, so two callers cannot start two downloads. */
  private pending: Promise<UpdateStatus> | null = null

  constructor(options: UpdateServiceOptions) {
    this.updater = options.updater
    this.emit = options.emit
    this.intervalMs = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
    this.now = options.now ?? Date.now
    this.status = options.updater
      ? IDLE_UPDATE_STATUS
      : { state: 'unsupported', ...(options.reason ? { reason: options.reason } : {}) }
  }

  /** The current status; `system.updateStatus` returns exactly this. */
  getStatus(): UpdateStatus {
    return this.status
  }

  /**
   * Subscribes, checks once and then every `intervalMs`.
   *
   * Called from `src/main/index.ts` after the window exists, and never from a
   * test's context construction — which is why the timer is started here rather
   * than in the constructor. A build that cannot update does nothing at all: no
   * subscription, no timer, no network.
   */
  start(): void {
    if (!this.updater || this.timer) return
    this.ensureSubscribed()
    // The launch check, deliberately not awaited: a failing feed must not delay
    // the first window, and the failure lands in the status like any other.
    void this.check()
    this.timer = setInterval(() => {
      void this.check()
    }, this.intervalMs)
    // A six-hour timer must not be a reason for the process to stay alive.
    this.timer.unref?.()
  }

  /** Stops the schedule and the subscription. Safe to call more than once. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /**
   * Asks the feed now, and answers with the status the check left behind.
   *
   * A second call while one is in flight joins the first rather than starting a
   * second download: the button in Settings → About is clickable while the
   * spinner is turning, and the six-hour timer can land on top of a click.
   */
  check(): Promise<UpdateStatus> {
    const updater = this.updater
    if (!updater) return Promise.resolve(this.status)
    if (this.pending) return this.pending

    // Not only in `start()`: a manual check is reachable before the schedule has
    // been started at all (a server build, a test, a second window opened during
    // launch), and a check whose events nobody is listening to would report
    // `checking` for ever.
    this.ensureSubscribed()

    const run = (async (): Promise<UpdateStatus> => {
      this.apply({ kind: 'checking' })
      try {
        await updater.check()
      } catch (cause) {
        this.apply({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      }
      return this.status
    })().finally(() => {
      this.pending = null
    })

    this.pending = run
    return run
  }

  /**
   * Restarts into the downloaded version.
   *
   * Refuses rather than silently doing nothing when there is nothing downloaded:
   * the renderer only offers the button in the `downloaded` state, so reaching
   * here otherwise is a bug worth seeing.
   */
  install(): void {
    if (!this.updater || this.status.state !== 'downloaded') {
      throw new BackendFailure('validation', NOTHING_TO_INSTALL)
    }
    this.updater.install()
  }

  /** Subscribes to the updater once; a no-op afterwards and without one. */
  private ensureSubscribed(): void {
    if (!this.updater || this.unsubscribe) return
    this.unsubscribe = this.updater.subscribe((event) => {
      this.apply(event)
    })
  }

  /**
   * Folds one updater event into the status and announces the two transitions
   * the renderer cares about.
   *
   * The events fire on the **transition**, not on the state: `download-progress`
   * arrives dozens of times and `update-downloaded` can be re-reported, and a
   * renderer that received `update.downloaded` twice would raise the notice bar
   * again after the user dismissed it.
   */
  private apply(event: UpdateEvent): void {
    const previous = this.status
    this.status = reduceUpdate(previous, event, this.now)
    if (this.status === previous) return

    const { state, version } = this.status
    if (state === 'available' && previous.state !== 'available' && version) {
      this.emit({ type: 'update.available', version })
    }
    if (state === 'downloaded' && previous.state !== 'downloaded' && version) {
      this.emit({ type: 'update.downloaded', version })
    }
  }
}
