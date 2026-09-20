/**
 * The local MCP endpoint and the coding agents pointed at it (S10.4, WP-12).
 *
 * One read and three writes, and the smallest store in the app that is not a
 * mirror of a single row: `integrations.status` answers everything the section
 * draws, and `connect` / `disconnect` answer with the **same shape**, so a click
 * needs no second read to redraw the card it was made on (WP-11).
 *
 * Three decisions are worth stating, because each of them is one the section
 * would otherwise have to make for itself:
 *
 * 1. **The switch is driven from `status.endpoint.enabled`, not from the settings
 *    store.** `integrations.connect` enables the endpoint server-side before it
 *    registers anything, so a switch reading `settings.mcpEndpoint.enabled` would
 *    sit at "off" after a successful Connect until something else re-read the
 *    row. The status this store holds is the authoritative answer to both
 *    questions, and it arrives with every call.
 * 2. **The settings store is kept in step anyway.** It is the app-wide mirror of
 *    that row and other screens read it, so a toggle goes *through* it
 *    (`setMcpEndpoint`, which is what actually starts and stops the host) and a
 *    successful `connect` re-reads it. Two mirrors of one row that disagree are
 *    worse than one extra call on a click.
 * 3. **Nothing here rejects.** Every failure lands in `error` / `errorCode` /
 *    `errorDetails`, the trio `i18n/errors.ts` turns into a sentence, exactly as
 *    `stores/chats.ts` does. A refused Connect is a line under the card, not an
 *    unhandled rejection in a click handler.
 *
 * `busyClient` is a single id rather than a set: the two buttons are on one
 * screen and a user presses one of them, and the card whose call is in flight is
 * the one that has to show it.
 */
import { create } from 'zustand'
import type { BackendErrorCode, IdeClientId, IntegrationStatus } from '@shared/types'
import { BackendClientError } from '../lib/backend'
import { getBackend } from '../lib/backend-provider'
import { useSettingsStore } from './settings'

export type IntegrationsStatus = 'idle' | 'loading' | 'ready' | 'error'

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function classify(cause: unknown): BackendErrorCode {
  return cause instanceof BackendClientError ? cause.code : 'internal'
}

function detailsOf(cause: unknown): unknown {
  return cause instanceof BackendClientError ? cause.details : undefined
}

export interface IntegrationsState {
  /** Backend-owned mirror of `integrations.status`; `null` until the first read. */
  status: IntegrationStatus | null
  loadStatus: IntegrationsStatus
  /** The client whose Connect / Disconnect is in flight, or `null`. */
  busyClient: IdeClientId | null
  /** True while the switch's own write is in flight. */
  togglingEndpoint: boolean
  /** Developer-facing detail of the last failure; the UI shows translated copy. */
  error?: string | undefined
  errorCode?: BackendErrorCode | undefined
  errorDetails?: unknown

  /** Reads the whole picture. Never rejects: failures land in `loadStatus`. */
  load: () => Promise<void>
  /** Throws the endpoint switch, then re-reads. Never rejects. */
  setEndpointEnabled: (enabled: boolean) => Promise<void>
  /** Points one client at this installation, repairing a stale one. Never rejects. */
  connect: (client: IdeClientId) => Promise<void>
  /** Removes this installation from one client. Never rejects. */
  disconnect: (client: IdeClientId) => Promise<void>
}

const CLEAR = { error: undefined, errorCode: undefined, errorDetails: undefined } as const

export const useIntegrationsStore = create<IntegrationsState>()((set) => ({
  status: null,
  loadStatus: 'idle',
  busyClient: null,
  togglingEndpoint: false,
  ...CLEAR,

  async load() {
    set({ loadStatus: 'loading', ...CLEAR })
    try {
      const status = await getBackend().invoke('integrations.status')
      set({ status, loadStatus: 'ready', ...CLEAR })
    } catch (cause) {
      // The section must still render: "we could not ask" is a line on the
      // screen, not a blank pane.
      set({
        loadStatus: 'error',
        error: describe(cause),
        errorCode: classify(cause),
        errorDetails: detailsOf(cause)
      })
    }
  },

  async setEndpointEnabled(enabled) {
    set({ togglingEndpoint: true, ...CLEAR })
    try {
      // Through the settings store, which owns the row — and whose write is what
      // starts or stops the listening host (WP-7). The status is then re-read,
      // because `listening` is a fact about this process that `settings.update`
      // does not report.
      await useSettingsStore.getState().setMcpEndpoint({ enabled })
      const status = await getBackend().invoke('integrations.status')
      set({ status, loadStatus: 'ready', ...CLEAR })
    } catch (cause) {
      set({
        error: describe(cause),
        errorCode: classify(cause),
        errorDetails: detailsOf(cause)
      })
    } finally {
      set({ togglingEndpoint: false })
    }
  },

  async connect(client) {
    set({ busyClient: client, ...CLEAR })
    try {
      const status = await getBackend().invoke('integrations.connect', { client })
      set({ status, loadStatus: 'ready', ...CLEAR })
      // `connect` enabled the endpoint on its way through the handler, so the
      // app-wide mirror of that row is now stale. `load` never rejects.
      await useSettingsStore.getState().load()
    } catch (cause) {
      set({
        error: describe(cause),
        errorCode: classify(cause),
        errorDetails: detailsOf(cause)
      })
    } finally {
      set({ busyClient: null })
    }
  },

  async disconnect(client) {
    set({ busyClient: client, ...CLEAR })
    try {
      const status = await getBackend().invoke('integrations.disconnect', { client })
      // Disconnect deliberately leaves the endpoint listening (WP-11), so the
      // settings row cannot have changed and there is nothing to re-read.
      set({ status, loadStatus: 'ready', ...CLEAR })
    } catch (cause) {
      set({
        error: describe(cause),
        errorCode: classify(cause),
        errorDetails: detailsOf(cause)
      })
    } finally {
      set({ busyClient: null })
    }
  }
}))
