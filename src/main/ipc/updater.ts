/**
 * The real updater (S7.4): `electron-updater` translated into the Electron-free
 * `Updater` port.
 *
 * The fourth module that is allowed to import outside the Electron-free layer,
 * and the first whose import is a *library* rather than electron itself.
 * `electron-updater` reads `app.getVersion()`, the `app-update.yml` electron-builder
 * writes into the bundle, and the code signature of what it downloaded — it is
 * electron in everything but the package name, so it lives here beside
 * `./dialogs.ts`, `./theme.ts` and `./editor.ts` (CLAUDE.md rule #5).
 *
 * Everything above it is Electron-free: `src/main/updates/service.ts` owns the
 * status, the six-hour schedule and the events, and `src/main/updates/state.ts`
 * owns the transitions. This file has no state of its own.
 *
 * ## The feed, and why it does not work yet
 *
 * `electron-builder.yml` publishes to `provider: github`, so a packaged build
 * carries an `app-update.yml` pointing at this repository's Releases and
 * `electron-updater` reads `latest-mac.yml` from the release assets. **The
 * repository is private today**, and GitHub serves a private repository's
 * release assets only with an authenticated request — a token that would have to
 * be inside the app, readable by anyone who downloaded it. There is no version of
 * that which is safe, so none is shipped: `provider: github` stays, because the
 * owner intends to make the repository public, and until that happens a check
 * ends in `state: 'error'` with GitHub's own 404 under it. See
 * `docs/features/packaging/backend.md`, "Auto-update".
 *
 * ## The test hook
 *
 * `WITENA_UPDATE_FEED` points the updater at a **generic** feed instead — a
 * directory served over HTTP holding `latest-mac.yml` and the zip it names,
 * which is what `electron-builder` produces beside the dmg. It exists so the
 * download path can be exercised without a GitHub release, and it deliberately
 * also lifts the signed/packaged gate below, because the whole point of it is to
 * run the updater on a build that would otherwise refuse. It is a developer's
 * environment variable, never a setting: nothing in the UI writes it and nothing
 * reads it back.
 */
import electronUpdater from 'electron-updater'
import type { UnsupportedReason, UpdateEvent } from '@shared/updates'
import type { Updater } from '../updates/service'

/**
 * `electron-updater` is CommonJS and this project is ESM (`"type": "module"`),
 * so `import { autoUpdater } from 'electron-updater'` type-checks and then fails
 * at runtime with "Named export 'autoUpdater' not found" — Node cannot see a
 * CJS module's named exports through electron-vite's externalised import. The
 * default import plus a destructure is the documented interop, and the error
 * message itself recommends it.
 */
const { autoUpdater } = electronUpdater

/** Points the updater at a generic feed instead of the GitHub release. */
export const UPDATE_FEED_ENV = 'WITENA_UPDATE_FEED'

export interface ElectronUpdaterOptions {
  /** `app.isPackaged`. A checkout has no bundle to replace. */
  packaged: boolean
  /** S7.3's `witenaSignedBuild`, read from the packaged manifest by `index.ts`. */
  signed: boolean
  /** `process.env.WITENA_UPDATE_FEED`, when set. */
  feedUrl?: string | undefined
}

/**
 * Either an updater, or the reason there is none.
 *
 * A discriminated pair rather than a nullable return, because the reason is shown
 * to the user and losing it would leave Settings → About saying "unsupported"
 * with nothing after it.
 */
export type UpdaterSetup = { updater: Updater } | { updater: null; reason: UnsupportedReason }

/**
 * Decides whether this build may update itself, and wires the library if it may.
 *
 * The order of the gates is the order of the reasons: a checkout is a checkout
 * whether or not it would have been signed.
 */
export function createElectronUpdater(options: ElectronUpdaterOptions): UpdaterSetup {
  const { packaged, signed, feedUrl } = options

  if (!feedUrl) {
    if (!packaged) return { updater: null, reason: 'development' }
    if (!signed) return { updater: null, reason: 'unsigned' }
  }

  if (feedUrl) {
    // `forceDevUpdateConfig` is what lets the updater run outside a packaged
    // bundle at all; without it `isUpdaterActive()` returns false and every
    // check resolves with null, which would look like "up to date" forever.
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
  }

  // Both are electron-updater's defaults, restated because the state machine
  // depends on them: `available` is followed by progress without anyone asking,
  // and a user who never presses Restart still gets the update on the next quit.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = console

  return { updater: electronUpdaterPort() }
}

/** The adapter itself: six library events in, one normalised union out. */
function electronUpdaterPort(): Updater {
  return {
    subscribe(listener: (event: UpdateEvent) => void): () => void {
      const onChecking = (): void => {
        listener({ kind: 'checking' })
      }
      const onAvailable = (info: { version: string }): void => {
        listener({ kind: 'available', version: info.version })
      }
      const onNotAvailable = (): void => {
        listener({ kind: 'not-available' })
      }
      const onProgress = (progress: { percent: number }): void => {
        listener({ kind: 'progress', percent: progress.percent })
      }
      const onDownloaded = (info: { version: string }): void => {
        listener({ kind: 'downloaded', version: info.version })
      }
      // An `error` event with no listener is re-thrown by EventEmitter and would
      // take the main process with it, so this one is not optional.
      const onError = (error: Error): void => {
        listener({ kind: 'error', message: error?.message ?? String(error) })
      }

      autoUpdater.on('checking-for-update', onChecking)
      autoUpdater.on('update-available', onAvailable)
      autoUpdater.on('update-not-available', onNotAvailable)
      autoUpdater.on('download-progress', onProgress)
      autoUpdater.on('update-downloaded', onDownloaded)
      autoUpdater.on('error', onError)

      return () => {
        autoUpdater.off('checking-for-update', onChecking)
        autoUpdater.off('update-available', onAvailable)
        autoUpdater.off('update-not-available', onNotAvailable)
        autoUpdater.off('download-progress', onProgress)
        autoUpdater.off('update-downloaded', onDownloaded)
        autoUpdater.off('error', onError)
      }
    },

    async check(): Promise<void> {
      await autoUpdater.checkForUpdates()
    },

    install(): void {
      // `isSilent: false` keeps the installer's own progress visible on a slow
      // swap; `isForceRunAfter: true` is what makes "Restart to update" actually
      // restart rather than just quit.
      autoUpdater.quitAndInstall(false, true)
    }
  }
}
