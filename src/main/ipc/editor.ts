/**
 * The third handler that may import electron (S5.7), and the first that only
 * *sometimes* needs to.
 *
 * Same shape as `./dialogs.ts` and `./theme.ts`, with one difference worth
 * knowing before reading it: this module implements **both** halves of
 * `system.openInEditor`, not just the electron one.
 *
 * - `AppSettings.editor.kind` of `'vscode'` or `'cursor'` is a URL scheme.
 *   Handing a URL to the platform is `shell.openExternal`, which is electron and
 *   has no injectable stand-in — the same exception `pickFolder` makes for the
 *   native modal.
 * - `'custom'` is a command line, which is `node:child_process` and needs nothing
 *   from the window system. `handlers/system.ts` already runs that branch.
 *
 * This file runs the custom branch as well rather than delegating to the
 * Electron-free handler, because the alternative is to call that handler, catch
 * its rejection and try the URL — a control flow in which an unrelated failure
 * would silently become "open a URL instead". Both branches come out of the one
 * `planOpenInEditor`, so the two builds cannot disagree about the path rules,
 * which is the only thing that has to be shared.
 *
 * `shell.openExternal` resolves when the platform *accepted* the URL, not when
 * an editor appeared: an unregistered scheme (VS Code was never installed) is a
 * rejection on macOS, which is why it is awaited at all — the renderer paints a
 * failed chip from it.
 */
import { shell } from 'electron'
import { planOpenInEditor, spawnEditorCommand } from '../editor/open'
import type { HandlerModule } from '../handlers/types'

export const editorHandlers: HandlerModule = {
  'system.openInEditor': async (ctx, input) => {
    const plan = planOpenInEditor(ctx, input)
    if (plan.kind === 'command') {
      spawnEditorCommand(plan.command)
      return
    }
    await shell.openExternal(plan.url)
  }
}
