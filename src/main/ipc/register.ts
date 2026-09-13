/**
 * The Electron transport: two channels, no domain knowledge.
 *
 * This file is the whole Electron-specific surface of the backend. It turns
 * `ipcMain.handle` calls into handler invocations and bus events into
 * `webContents.send`. Replacing it with an HTTP router plus a WebSocket
 * broadcaster is what "the backend can move to a Node server" means in practice —
 * no handler, repository or service changes (CLAUDE.md rule #5).
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { isBackendMethod } from '@shared/backend'
import type { AppContext } from '../app-context'
import type { EventBus } from '../events/bus'
import type { HandlerMap } from '../handlers/types'
import { BackendFailure } from '../errors'
import { IPC_EVENT, IPC_INVOKE, toBackendError, type InvokeResponse } from '../ipc-protocol'

/** The erased call signature the transport works with; `HandlerMap` keeps the typing. */
type ErasedHandler = (ctx: AppContext, input: unknown) => unknown

/**
 * Registers the single request/response channel.
 *
 * Invariants:
 * - **Never rejects.** Electron would flatten the thrown value to its message and
 *   the renderer would lose `code` and `details`, so failures resolve as
 *   `{ ok: false, error }` (see `ipc-protocol.ts`).
 * - **Never dispatches an unknown name.** `isBackendMethod` gates the lookup, so
 *   a compromised renderer cannot reach anything that is not a declared method.
 */
export function registerIpc(ipcMain: IpcMain, ctx: AppContext, handlers: HandlerMap): void {
  ipcMain.handle(IPC_INVOKE, async (_event, method: unknown, input: unknown): Promise<InvokeResponse> => {
    try {
      if (!isBackendMethod(method)) {
        throw new BackendFailure('validation', `Unknown backend method: ${String(method)}`)
      }
      const handler = handlers[method] as ErasedHandler
      const value = await handler(ctx, input)
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: toBackendError(error) }
    }
  })
}

/**
 * Forwards every bus event to every open window and returns the unsubscribe
 * function.
 *
 * Windows are resolved on each emit rather than captured once, so a window opened
 * later (macOS `activate`) receives events without re-registering, and a window
 * being torn down is skipped instead of throwing inside the bus.
 */
export function forwardEvents(events: EventBus, getWindows: () => BrowserWindow[]): () => void {
  return events.subscribe((event) => {
    for (const window of getWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send(IPC_EVENT, event)
    }
  })
}
