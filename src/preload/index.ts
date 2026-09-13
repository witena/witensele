/**
 * The context bridge: the only place where the renderer and Electron meet.
 *
 * It is deliberately dumb. It forwards `invoke` to one channel, relays events
 * from another, and understands neither the method list nor the response
 * envelope — decoding the envelope and rebuilding the error is the renderer
 * client's job (`src/renderer/src/lib/backend.ts`), because that is the layer a
 * future HTTP transport replaces.
 *
 * Only plain data crosses `contextBridge`: functions, class instances and
 * prototypes do not survive, which is why every shared type is JSON serializable
 * and errors travel as plain `BackendError` objects.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { BackendMethod } from '@shared/backend'
import type { BackendEvent } from '@shared/events'
import { IPC_EVENT, IPC_INVOKE, type InvokeResponse } from '../main/ipc-protocol'

/**
 * The object exposed as `window.witena`, built from the main-process envelope.
 *
 * `index.d.ts` restates this interface for the renderer project, which is not
 * allowed to pull files out of `src/main/`. The two must be edited together; a
 * mismatch shows up immediately as a type error in
 * `src/renderer/src/lib/backend.ts`, which derives its envelope from the ambient
 * declaration and feeds it straight back into the shared `BackendClient` types.
 */
export interface WitenaBridge {
  /** Resolves with the response envelope; it never rejects for a backend failure. */
  invoke(method: BackendMethod, input?: unknown): Promise<InvokeResponse>
  /** Subscribes to the backend event stream. Returns the remover. */
  onEvent(listener: (event: BackendEvent) => void): () => void
}

const witena: WitenaBridge = {
  invoke(method, input) {
    return ipcRenderer.invoke(IPC_INVOKE, method, input) as Promise<InvokeResponse>
  },

  onEvent(listener) {
    // The IpcRendererEvent itself must not reach the renderer: it carries
    // `sender` and ports that would leak Electron into the page.
    const relay = (_event: IpcRendererEvent, payload: BackendEvent): void => {
      listener(payload)
    }
    ipcRenderer.on(IPC_EVENT, relay)
    return () => {
      ipcRenderer.removeListener(IPC_EVENT, relay)
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('witena', witena)
} else {
  // Fallback for a non-isolated context; not reachable with the current config.
  ;(globalThis as unknown as { witena: WitenaBridge }).witena = witena
}
