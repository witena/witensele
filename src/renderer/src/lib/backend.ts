/**
 * The Electron implementation of `BackendClient`.
 *
 * This is the **only** file in the renderer allowed to know that a transport
 * exists (CLAUDE.md rule #6). Components call store actions, stores call
 * `BackendClient`, and swapping Electron IPC for HTTP + WebSocket means writing a
 * sibling of this file and changing the singleton below — nothing else.
 *
 * Two responsibilities the preload bridge deliberately does not have:
 *
 * 1. **Unwrapping the envelope.** The main process resolves every call with
 *    `{ ok, value }` or `{ ok, error }` because Electron flattens a rejected
 *    promise to its message and would lose `code` and `details`. The client turns
 *    the failure half back into a thrown error here.
 * 2. **Filtering events.** `subscribe` gets the whole `BackendEvent` union;
 *    `subscribeTo` narrows it by `type` so a store can listen to one kind.
 */
import type { BackendApi, BackendClient, BackendMethod } from '@shared/backend'
import type { BackendEvent, BackendEventType, EventOf } from '@shared/events'
import type { BackendError, BackendErrorCode } from '@shared/types'

/** The preload bridge, typed from the ambient `window.witena` declaration. */
export type WitenaBridge = Window['witena']

/** The envelope the bridge resolves with, derived so it cannot drift from preload. */
export type InvokeResponse = Awaited<ReturnType<WitenaBridge['invoke']>>

/**
 * The renderer-side error for a rejected `invoke`.
 *
 * A `BackendError` crosses the boundary as a plain object — prototypes do not
 * survive structured clone — so the client rebuilds a real `Error` around it.
 * Callers switch on `code` to pick an i18n key; `message` is developer-facing
 * detail and is never rendered.
 */
export class BackendClientError extends Error implements BackendError {
  readonly code: BackendErrorCode
  readonly details?: unknown

  constructor(error: BackendError) {
    super(error.message)
    this.name = 'BackendClientError'
    this.code = error.code
    if (error.details !== undefined) this.details = error.details
  }
}

/** `BackendClient` with `subscribeTo` guaranteed present. */
export type ElectronBackendClient = BackendClient & Required<Pick<BackendClient, 'subscribeTo'>>

function assertResponse(method: BackendMethod, response: unknown): asserts response is InvokeResponse {
  if (typeof response !== 'object' || response === null || !('ok' in response)) {
    throw new BackendClientError({
      code: 'internal',
      message: `Malformed response envelope for ${method}`,
      details: response
    })
  }
}

/**
 * Wraps a preload bridge in the transport-agnostic client interface.
 *
 * The bridge is a parameter so tests can pass a fake one instead of standing up
 * Electron; production code uses the lazy `backend` singleton below.
 */
export function createElectronBackendClient(bridge: WitenaBridge): ElectronBackendClient {
  return {
    async invoke<M extends BackendMethod>(
      method: M,
      ...args: Parameters<BackendApi[M]>
    ): Promise<unknown> {
      // Every method takes at most one object argument, so the first element is
      // the whole input; an argument-free method sends `undefined`.
      const response = await bridge.invoke(method, args[0])
      assertResponse(method, response)
      if (!response.ok) throw new BackendClientError(response.error)
      return response.value
    },

    subscribe(listener: (event: BackendEvent) => void): () => void {
      return bridge.onEvent(listener)
    },

    subscribeTo<T extends BackendEventType>(type: T, listener: (event: EventOf<T>) => void): () => void {
      return bridge.onEvent((event) => {
        if (event.type === type) listener(event as EventOf<T>)
      })
    }
  } as ElectronBackendClient
}

let instance: ElectronBackendClient | null = null

/**
 * The one client for the application, built on first use.
 *
 * Lazy because the module is imported during renderer bootstrap, before
 * `window.witena` is guaranteed to be installed, and because a test that imports
 * a store must not blow up merely for lacking a bridge.
 */
function client(): ElectronBackendClient {
  if (instance) return instance
  const bridge = (globalThis as { witena?: WitenaBridge }).witena
  if (!bridge) {
    throw new BackendClientError({
      code: 'internal',
      message: 'window.witena is not available: the preload bridge did not load'
    })
  }
  instance = createElectronBackendClient(bridge)
  return instance
}

/** The singleton every store imports. Delegates to the lazily built client. */
export const backend: ElectronBackendClient = {
  invoke: ((method, ...args) => client().invoke(method, ...args)) as ElectronBackendClient['invoke'],
  subscribe: (listener) => client().subscribe(listener),
  subscribeTo: ((type, listener) =>
    client().subscribeTo(type, listener)) as ElectronBackendClient['subscribeTo']
}
