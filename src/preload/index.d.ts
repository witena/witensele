/**
 * Ambient declaration of `window.witena`.
 *
 * The renderer's tsconfig includes this file so `src/renderer/src/lib/backend.ts`
 * — the single renderer file allowed to touch the bridge — is typed. No other
 * renderer file may reference `window.witena` (CLAUDE.md rule #6).
 *
 * It is **self-contained on purpose**: the renderer project may not pull files
 * out of `src/main/`, so the envelope is restated here rather than imported from
 * `src/main/ipc-protocol.ts`. `src/preload/index.ts` carries a compile-time check
 * that the two definitions are identical, so they cannot drift.
 */
import type { BackendMethod } from '../shared/backend'
import type { BackendEvent } from '../shared/events'
import type { BackendError } from '../shared/types'

/** Mirror of `InvokeResponse` in `src/main/ipc-protocol.ts`. */
export type InvokeResponse = { ok: true; value: unknown } | { ok: false; error: BackendError }

export interface WitenaBridge {
  /** Resolves with the response envelope; it never rejects for a backend failure. */
  invoke(method: BackendMethod, input?: unknown): Promise<InvokeResponse>
  /** Subscribes to the backend event stream. Returns the remover. */
  onEvent(listener: (event: BackendEvent) => void): () => void
}

declare global {
  interface Window {
    witena: WitenaBridge
  }
}

export {}
