/**
 * The one handler that must import electron.
 *
 * CLAUDE.md rule #5 keeps main-process business logic free of electron so the
 * whole layer can move to a Node server. `system.pickFolder` is the documented
 * exception: a native folder picker *is* a window-system feature, there is no
 * injectable stand-in for it, and the alternative — a text field the user pastes
 * an absolute path into — would be a worse product for the sake of a rule.
 *
 * The exception is kept honest by being confined to the layer that is already
 * allowed to import electron:
 *
 * - `handlers/system.ts` declares the method and rejects with
 *   `PICK_FOLDER_UNAVAILABLE`, so the Electron-free handler map stays total and
 *   a unit test gets a clear answer rather than a crash.
 * - `registerIpc` layers this module over that map, so the running app has the
 *   real one. Nothing else imports this file.
 * - A server build simply does not layer it, and the rejection is the truth.
 *
 * The dialog is deliberately plain: one directory, no multi-select, no file
 * creation. The only thing the renderer wants is a path to hand to
 * `skills.import`.
 */
import { dialog } from 'electron'
import type { HandlerModule } from '../handlers/types'

export const dialogHandlers: HandlerModule = {
  'system.pickFolder': async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  }
}
