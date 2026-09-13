/**
 * The three handlers that must import electron: the native file dialogs.
 *
 * CLAUDE.md rule #5 keeps main-process business logic free of electron so the
 * whole layer can move to a Node server. `system.pickFolder` is the documented
 * exception: a native folder picker *is* a window-system feature, there is no
 * injectable stand-in for it, and the alternative — a text field the user pastes
 * an absolute path into — would be a worse product for the sake of a rule.
 *
 * S5.10 adds two of the same shape rather than widening the first, because the
 * three answer genuinely different questions and a single method with a mode
 * flag would make every caller read the flag to know what it gets back:
 * `pickSavePath` names a file that **does not exist yet** (the deliverable of a
 * `document` goal), and `pickPaths` picks **several** files or folders at once
 * (a goal's materials).
 *
 * The exception is kept honest by being confined to the layer that is already
 * allowed to import electron:
 *
 * - `handlers/system.ts` declares each method and rejects with
 *   `PICK_FOLDER_UNAVAILABLE` / `PICK_SAVE_PATH_UNAVAILABLE` /
 *   `PICK_PATHS_UNAVAILABLE`, so the Electron-free handler map stays total and
 *   a unit test gets a clear answer rather than a crash.
 * - `registerIpc` layers this module over that map, so the running app has the
 *   real one. Nothing else imports this file.
 * - A server build simply does not layer it, and the rejection is the truth.
 *
 * Every dialog here is deliberately plain, and every one of them returns
 * **absolute** paths — the platform knows no other kind. Turning those into the
 * relative paths a goal stores is the renderer's job (`lib/workdir.ts`), and
 * refusing one that fell outside the chat's folder is the renderer's too: the
 * dialog cannot be confined to a directory on any platform this runs on, so the
 * conversion is where "outside the folder" is discovered.
 */
import { dialog } from 'electron'
import type { HandlerModule } from '../handlers/types'

/** The folder a dialog opens in, when the caller named a usable one. */
function startIn(input: unknown): { defaultPath?: string } {
  const defaultDir = (input as { defaultDir?: unknown })?.defaultDir
  return typeof defaultDir === 'string' && defaultDir.length > 0
    ? { defaultPath: defaultDir }
    : {}
}

export const dialogHandlers: HandlerModule = {
  'system.pickFolder': async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  },

  'system.pickSavePath': async (_ctx, input) => {
    // `createDirectory` is the macOS "New Folder" button: a deliverable is
    // routinely the first file in a folder that does not exist yet, and the
    // goal's own validation is explicit that its parent need not be there.
    const result = await dialog.showSaveDialog({
      ...startIn(input),
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (result.canceled) return null
    return result.filePath ?? null
  },

  'system.pickPaths': async (_ctx, input) => {
    const result = await dialog.showOpenDialog({
      ...startIn(input),
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })
    // An empty array, not `null`: a caller that is appending to a list treats
    // "cancelled" and "picked nothing" identically, and one of the two shapes
    // would otherwise have to be unwrapped at every call site.
    if (result.canceled) return []
    return result.filePaths
  }
}
