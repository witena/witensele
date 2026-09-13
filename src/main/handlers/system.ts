/**
 * `system.*` — the transport's own probes.
 *
 * They carry no domain meaning: `system.ping` proves the request/response
 * direction works end to end and `system.emitTestEvent` proves the push
 * direction does. Both are exercised by the Playwright harness in `e2e/`.
 */
import { planOpenInEditor, spawnEditorCommand } from '../editor/open'
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
 * The same arrangement for the save dialog (S5.10).
 *
 * A `document` goal's deliverable can be typed into the field beside it, so this
 * one is a convenience rather than the only way in — but the convenience is what
 * keeps a user from having to remember a path, and only the window system can
 * offer it.
 */
export const PICK_SAVE_PATH_UNAVAILABLE =
  'system.pickSavePath needs a window: it is implemented in src/main/ipc/dialogs.ts and registered by registerIpc'

/** The same again for the multi-select open dialog behind a goal's materials (S5.10). */
export const PICK_PATHS_UNAVAILABLE =
  'system.pickPaths needs a window: it is implemented in src/main/ipc/dialogs.ts and registered by registerIpc'

/**
 * The same arrangement for the theme (S5.8).
 *
 * `system.applyTheme` tints what the renderer cannot paint — the traffic lights
 * of `titleBarStyle: 'hiddenInset'` and the native dialogs — which is
 * `nativeTheme.themeSource` and therefore electron. The page itself needs
 * nothing from this call: `data-theme` on `<html>` repaints the whole UI, so a
 * build that rejects here is a correct build with slightly wrong window chrome.
 */
export const APPLY_THEME_UNAVAILABLE =
  'system.applyTheme needs a window: it is implemented in src/main/ipc/theme.ts and registered by registerIpc'

/**
 * The one method whose need for a window depends on a **setting** (S5.7).
 *
 * `AppSettings.editor` decides. `kind: 'custom'` is a command line and runs right
 * here — `node:child_process` is ordinary Node and is allowed in this layer — so
 * a server build with a custom editor configured would actually work. The two
 * named editors are URL schemes, and only `shell.openExternal` can hand a URL to
 * the platform, so those reject with this message and `src/main/ipc/editor.ts`
 * overrides them.
 *
 * Both branches are decided by `planOpenInEditor`, so the path is confined
 * identically whichever build is running; see `src/main/editor/open.ts`.
 */
export const OPEN_IN_EDITOR_UNAVAILABLE =
  'system.openInEditor needs a window for the vscode:// and cursor:// schemes: it is implemented in src/main/ipc/editor.ts and registered by registerIpc'

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

  'system.pickSavePath': async () => {
    throw new BackendFailure('internal', PICK_SAVE_PATH_UNAVAILABLE)
  },

  'system.pickPaths': async () => {
    throw new BackendFailure('internal', PICK_PATHS_UNAVAILABLE)
  },

  'system.applyTheme': async () => {
    throw new BackendFailure('internal', APPLY_THEME_UNAVAILABLE)
  },

  'system.openInEditor': async (ctx, input) => {
    // The path is validated before the setting is even read, so a refusal says
    // the same thing in both builds.
    const plan = planOpenInEditor(ctx, input)
    if (plan.kind === 'command') {
      spawnEditorCommand(plan.command)
      return
    }
    throw new BackendFailure('internal', OPEN_IN_EDITOR_UNAVAILABLE)
  }
}
