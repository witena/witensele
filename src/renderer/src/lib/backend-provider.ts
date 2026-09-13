/**
 * The seam that lets a zustand store reach the backend without importing a
 * transport.
 *
 * `lib/backend.ts` builds its client around `window.witena`, which no store may
 * depend on: a store must be testable in plain Node with a fake client, and the
 * same store has to keep working when the Electron transport is swapped for HTTP
 * (CLAUDE.md rule #6). So stores call `getBackend()`, production code leaves the
 * default in place, and a test calls `setBackend(fake)` in `beforeEach` and
 * `resetBackend()` in `afterEach`.
 *
 * This is deliberately a module-level singleton rather than React context: the
 * stores are vanilla zustand and are used outside the component tree (the
 * bootstrap in `main.tsx` loads settings before the first render).
 */
import type { BackendClient } from '@shared/backend'
import { backend } from './backend'

let current: BackendClient = backend

/** The client every store calls. */
export function getBackend(): BackendClient {
  return current
}

/** Replaces the client. Tests use it; production never does. */
export function setBackend(client: BackendClient): void {
  current = client
}

/** Restores the real Electron-backed client. */
export function resetBackend(): void {
  current = backend
}
