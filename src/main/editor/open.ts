/**
 * `system.openInEditor`, minus the one line that needs a window (S5.7).
 *
 * PLAN.md's "Future extension", point 3, step one: a path or a diff header in a
 * message opens that file in the user's editor. Two things have to happen before
 * anything is launched — the path has to be checked, and the stored
 * `AppSettings.editor` has to be turned into either a URL or a command line —
 * and both of them are here, in a module that imports no electron (CLAUDE.md
 * rule #5).
 *
 * ## Why the implementation is split in two, and why the split is *this* one
 *
 * `vscode://file/<path>:<line>` and `cursor://file/...` are URLs, and handing a
 * URL to the platform is `shell.openExternal` — electron. `code -g <path>:<line>`
 * is a command line, and running one is `node:child_process` — not electron. So
 * the method is half window-system and half not, which is new: `pickFolder` and
 * `applyTheme` are entirely window-system and reject outright in a server build.
 *
 * The split therefore runs through `planOpenInEditor`, which does **all** of the
 * deciding and returns what to do rather than doing it. `handlers/system.ts`
 * runs the `command` half and rejects on the `url` half; `src/main/ipc/editor.ts`
 * runs both. Neither of them validates anything of its own, which is the point:
 * a path confined in one caller and not the other would be a confinement bug
 * that only shows up in one build.
 *
 * ## The path rules
 *
 * 1. **Absolute.** A relative path means nothing to a URL scheme, and nothing to
 *    a command line whose working directory is the app's. The renderer already
 *    knows the folder it resolved a chip against, so it is the renderer's job to
 *    send an absolute path — and `editor_path_not_absolute` says so when it does
 *    not.
 * 2. **Inside the chat's folder**, when a `chatId` is given and that chat is
 *    bound to one. This is `resolveInWorkdir`, the executor's own confinement
 *    rule, reused rather than re-derived: symlinks, `..` and a path that does not
 *    exist yet are all already handled there, and a second implementation would
 *    be a second chance to get them wrong.
 *
 * A call with no `chatId`, or from a chat with no folder, keeps only rule 1.
 * That is deliberate and it is not a hole: the *user* asked for this file by
 * clicking a chip, and refusing to open their own `~/notes.md` because the chat
 * happens to be unbound would be the app second-guessing a direct instruction.
 * Rule 2 exists because the path in a chip is *model* output — the same class of
 * input the executor's tools take — and a model that writes `/etc/passwd:1` into
 * a message must not get a click that opens it.
 *
 * ## The file is not required to exist
 *
 * Nothing here stats the target. The renderer's detector is lexical (it has no
 * filesystem), an editor opens a missing file as an empty buffer, and a refusal
 * would turn a stale path in an old message into an error the user cannot act
 * on. Opening the wrong-but-harmless buffer is the better failure.
 */
import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import type { EditorSettings } from '@shared/types'
import type { AppContext } from '../app-context'
import { validation } from '../errors'
import { resolveInWorkdir } from '../executor/paths'

/** What `system.openInEditor` accepts, after the transport has handed it over. */
export interface OpenInEditorInput {
  path: string
  line?: number | undefined
  chatId?: string | undefined
}

/** The file to open, once both rules have been applied to it. */
export interface EditorTarget {
  /** The absolute path, resolved through the workdir's realpath when confined. */
  absolute: string
  /** 1-based, or `undefined` for "the top of the file". */
  line: number | undefined
}

/**
 * What the caller should do, decided entirely here.
 *
 * `url` needs `shell.openExternal`; `command` needs a shell. Everything else —
 * which of the two, what the string is — has already been worked out.
 */
export type OpenInEditorPlan =
  | { kind: 'url'; url: string; target: EditorTarget }
  | { kind: 'command'; command: string; target: EditorTarget }

/** The line a template's `{line}` gets when the reference carried none. */
export const DEFAULT_EDITOR_LINE = 1

/**
 * `input` checked against both rules, or a refusal carrying a `ValidationReason`.
 *
 * The reasons travel in `BackendError.details` so the renderer can say *which*
 * rule was broken; `i18n/errors.ts` translates them.
 */
export function resolveEditorTarget(ctx: AppContext, input: OpenInEditorInput): EditorTarget {
  const path = typeof input?.path === 'string' ? input.path.trim() : ''
  if (path.length === 0 || !isAbsolute(path)) {
    throw validation(`system.openInEditor needs an absolute path: ${String(input?.path)}`, {
      reason: 'editor_path_not_absolute'
    })
  }

  const line = input.line
  if (line !== undefined && (!Number.isInteger(line) || line < 1)) {
    throw validation(`system.openInEditor received an invalid line: ${String(line)}`)
  }

  const workdir = editorWorkdir(ctx, input.chatId)
  if (workdir === null) {
    return { absolute: resolve(path), line }
  }

  try {
    // The executor's rule, unchanged: relative-or-absolute in, confined out.
    return { absolute: resolveInWorkdir(workdir, path).absolute, line }
  } catch {
    // `resolveInWorkdir` refuses a path outside the folder *and* a folder that
    // has since vanished. Both mean the same thing to the user — this file
    // cannot be opened from this chat — and the narrower reason is the useful
    // one to show.
    throw validation(`system.openInEditor: ${path} is outside the chat's working directory`, {
      reason: 'editor_path_outside_workdir'
    })
  }
}

/**
 * The folder that confines this call, or `null` when nothing does.
 *
 * A `chatId` that names a chat which no longer exists is `null` rather than an
 * error: the message may still be on screen in a window that has not caught up,
 * and rule 1 still applies.
 */
function editorWorkdir(ctx: AppContext, chatId: string | undefined): string | null {
  if (typeof chatId !== 'string' || chatId.length === 0) return null
  try {
    const workdir = ctx.repos.chats.get(chatId, ctx.userId).workdir
    return typeof workdir === 'string' && workdir.trim().length > 0 ? workdir : null
  } catch {
    return null
  }
}

/**
 * A value made safe to drop into a `/bin/sh -c` line.
 *
 * Single quotes, with the one escape POSIX sh allows inside them: close, an
 * escaped quote, reopen. The path comes from a model by way of the renderer, so
 * this is the boundary that keeps `notes.md; rm -rf ~` a filename rather than a
 * second command.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * `command` with `{path}` and `{line}` substituted.
 *
 * The path is substituted **quoted**, which is what makes a template as naive as
 * `code -g {path}:{line}` correct for `/Users/ada/My Projects/a.ts`. A template
 * that quotes the placeholder itself (`code '{path}'`) would double-quote it, so
 * the documentation and the placeholder text both say not to — the substitution
 * is the quoting.
 *
 * A reference with no line gets line 1, because the default template has
 * `:{line}` welded into it and `code -g file:` is not a thing. The top of the
 * file is what "no line" means anyway.
 */
export function expandEditorCommand(command: string, target: EditorTarget): string {
  return command
    .replaceAll('{path}', shellQuote(target.absolute))
    .replaceAll('{line}', String(target.line ?? DEFAULT_EDITOR_LINE))
}

/**
 * The `vscode://` or `cursor://` URL for a target.
 *
 * `file/` then the absolute path, with `:line` appended only when there is one —
 * the scheme treats a trailing colon as part of the filename. The path is
 * percent-encoded per segment: a `#` or a `?` in a directory name would otherwise
 * truncate the URL, and `encodeURIComponent` on the whole path would eat the
 * separators.
 */
export function editorUrl(kind: 'vscode' | 'cursor', target: EditorTarget): string {
  const encoded = target.absolute.split('/').map(encodeURIComponent).join('/')
  const suffix = target.line === undefined ? '' : `:${target.line}`
  return `${kind}://file${encoded}${suffix}`
}

/**
 * The whole decision: check the path, read the setting, produce one of the two
 * plans.
 *
 * Reading the setting here rather than in each caller is what keeps the two
 * builds honest — the Electron-free handler and the overlay both ask this
 * function, so they can never disagree about which editor the user picked.
 */
export function planOpenInEditor(ctx: AppContext, input: OpenInEditorInput): OpenInEditorPlan {
  const target = resolveEditorTarget(ctx, input)
  const editor: EditorSettings = ctx.repos.settings.get(ctx.userId).editor

  if (editor.kind === 'custom') {
    return { kind: 'command', command: expandEditorCommand(editor.command, target), target }
  }
  return { kind: 'url', url: editorUrl(editor.kind, target), target }
}

/**
 * Runs a custom command line and forgets about it.
 *
 * `detached` plus `unref`, and stdio thrown away: an editor is a long-lived
 * process the user is about to type into, not a tool call with an output to
 * collect, and a child kept attached would hold the app's event loop and die
 * with it. Nothing is awaited for the same reason — the platform has no way to
 * report "the window came to the front", so `system.openInEditor` resolves as
 * soon as the process is spawned.
 *
 * A spawn error (no `/bin/sh`, which cannot happen on macOS) is swallowed into
 * the `error` listener rather than left to become an unhandled event on the
 * child, because a failure to open an editor must not take the app down.
 */
export function spawnEditorCommand(command: string): void {
  const child = spawn('/bin/sh', ['-c', command], {
    detached: true,
    stdio: 'ignore'
  })
  child.on('error', () => undefined)
  child.unref()
}
