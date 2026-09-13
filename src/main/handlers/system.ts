/**
 * `system.*` — the transport's own probes.
 *
 * They carry no domain meaning: `system.ping` proves the request/response
 * direction works end to end and `system.emitTestEvent` proves the push
 * direction does. Both are exercised by the Playwright harness in `e2e/`.
 */
import { BackendFailure, validation } from '../errors'
import type { HandlerModule } from './types'

/**
 * What `system.pickFolder` answers with when nothing has layered a real
 * implementation over it.
 *
 * The folder picker is the **one** backend method that cannot be written without
 * electron: a native modal belongs to the window system. So the Electron-free
 * handler layer declares it and rejects, and `src/main/ipc/dialogs.ts` — which
 * is allowed to import electron (CLAUDE.md rule #5) — overrides it inside
 * `registerIpc`. A unit test, and a future server build, get this rejection,
 * which is the honest answer rather than a silent `null`.
 */
export const PICK_FOLDER_UNAVAILABLE =
  'system.pickFolder needs a window: it is implemented in src/main/ipc/dialogs.ts and registered by registerIpc'

/**
 * The same arrangement for the second window-system method (S5.8).
 *
 * `system.applyTheme` tints what the renderer cannot paint — the traffic lights
 * of `titleBarStyle: 'hiddenInset'` and the native dialogs — which is
 * `nativeTheme.themeSource` and therefore electron. The page itself needs
 * nothing from this call: `data-theme` on `<html>` repaints the whole UI, so a
 * build that rejects here is a correct build with slightly wrong window chrome.
 */
export const APPLY_THEME_UNAVAILABLE =
  'system.applyTheme needs a window: it is implemented in src/main/ipc/theme.ts and registered by registerIpc'

export const systemHandlers: HandlerModule = {
  'system.ping': async () => 'pong',

  'system.emitTestEvent': async (ctx, input) => {
    // The renderer is untrusted input like any other client, so the payload is
    // checked here rather than assumed from the TypeScript signature.
    if (typeof input?.payload !== 'string') {
      throw validation('system.emitTestEvent requires a string payload')
    }
    ctx.events.emit({ type: 'system.test', payload: input.payload })
  },

  'system.pickFolder': async () => {
    throw new BackendFailure('internal', PICK_FOLDER_UNAVAILABLE)
  },

  'system.applyTheme': async () => {
    throw new BackendFailure('internal', APPLY_THEME_UNAVAILABLE)
  }
}
