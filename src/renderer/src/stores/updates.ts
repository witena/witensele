/**
 * What the app knows about its own next version, in the renderer (S7.4).
 *
 * The backend owns the status; this store is a mirror of it plus the one piece
 * of state the backend has no business knowing — whether the user has waved the
 * notice bar away. Two surfaces read it: Settings → About (version, state,
 * "Check for updates") and the bar at the bottom of the window ("Restart to
 * update").
 *
 * The push half is deliberately small. There is no `update.progress` event, and
 * there should not be: a download of 150 MB producing an IPC message per chunk
 * would be a lot of traffic for a percentage nobody is watching. `update.available`
 * and `update.downloaded` are the two moments that change what the user can *do*,
 * and both carry the version, so the store can apply them without a round trip;
 * the percentage is only ever seen by someone who is looking at the About screen,
 * which asks for a fresh status when it mounts.
 */
import { create } from 'zustand'
import { IDLE_UPDATE_STATUS, type UpdateStatus } from '@shared/updates'
import { getBackend } from '../lib/backend-provider'

export interface UpdatesState {
  /** Backend-owned mirror of `system.updateStatus`. */
  status: UpdateStatus
  /** True while a check the user started is in flight, so the button can wait. */
  checking: boolean
  /**
   * The version whose notice bar the user dismissed.
   *
   * Per version rather than a boolean: dismissing 0.2.0 must not hide 0.3.0 a
   * week later. Renderer-local on purpose — it is a fact about this window, not
   * about the installation, and a bar that stayed dismissed across a restart
   * would hide an update the restart did not install.
   */
  dismissedVersion: string | null

  /** Reads the cached status. Never rejects. */
  load: () => Promise<void>
  /** Asks the feed now and stores whatever the check left behind. Never rejects. */
  check: () => Promise<void>
  /** Restarts into the downloaded version. Rejects like any backend call. */
  install: () => Promise<void>
  /** Applies `update.available`. */
  applyAvailable: (version: string) => void
  /** Applies `update.downloaded`, which is what raises the bar. */
  applyDownloaded: (version: string) => void
  /** Hides the bar for the version currently offered. */
  dismiss: () => void
}

export const useUpdatesStore = create<UpdatesState>()((set, get) => ({
  status: IDLE_UPDATE_STATUS,
  checking: false,
  dismissedVersion: null,

  async load() {
    try {
      set({ status: await getBackend().invoke('system.updateStatus') })
    } catch {
      // A transport that has no such method is a build without updates, which
      // is exactly what `idle` already says. Nothing on screen depends on this
      // call succeeding, so it must not be able to break a settings page.
    }
  },

  async check() {
    set({ checking: true })
    try {
      set({ status: await getBackend().invoke('system.checkForUpdates') })
    } catch {
      // A failed *check* is reported by the backend as `state: 'error'` inside a
      // resolved status; reaching here means the call itself did not arrive, and
      // the previous status is still the best thing to show.
    } finally {
      set({ checking: false })
    }
  },

  async install() {
    await getBackend().invoke('system.installUpdate')
  },

  applyAvailable(version) {
    // Only ever a step forwards: the backend has already refused to move a
    // downloaded update back (see `src/main/updates/state.ts`), and this mirror
    // must not undo that on its own.
    if (get().status.state === 'downloaded') return
    set({ status: { ...get().status, state: 'available', version } })
  },

  applyDownloaded(version) {
    set({
      status: { ...get().status, state: 'downloaded', version, percent: 100 },
      // A newer version is a new offer, so an earlier dismissal does not carry
      // over. Comparing rather than clearing unconditionally keeps a repeated
      // announcement of the same version from raising a bar the user closed.
      ...(get().dismissedVersion === version ? {} : { dismissedVersion: null })
    })
  },

  dismiss() {
    set({ dismissedVersion: get().status.version ?? null })
  }
}))

/**
 * The version the notice bar should be offering, or `null` for no bar.
 *
 * A pure function rather than a condition inside the component, because it is
 * the single sentence that decides whether a persistent strip covers part of the
 * window: downloaded, named, and not waved away. Its own function rather than a
 * line inside the hook so the rule can be tested without React.
 */
export function updateReadyVersion(
  status: UpdateStatus,
  dismissedVersion: string | null
): string | null {
  if (status.state !== 'downloaded') return null
  if (status.version === undefined || status.version === dismissedVersion) return null
  return status.version
}

/** `updateReadyVersion` bound to the store, for the component. */
export function useUpdateReady(): string | null {
  return useUpdatesStore((state) => updateReadyVersion(state.status, state.dismissedVersion))
}
