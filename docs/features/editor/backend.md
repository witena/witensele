# editor — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/main/editor/open.ts` | The whole decision. `resolveEditorTarget` (the two path rules), `editorUrl`, `shellQuote`, `expandEditorCommand`, `planOpenInEditor` and `spawnEditorCommand`. **No electron** |
| `src/main/ipc/editor.ts` | The overlay: runs a `command` plan, and hands a `url` plan to `shell.openExternal`. The third file allowed to import electron |
| `src/main/handlers/system.ts` | Declares `system.openInEditor`, runs a `command` plan, rejects a `url` plan with `OPEN_IN_EDITOR_UNAVAILABLE` |
| `src/main/handlers/settings.ts` | `assertEditorPatch` — the kind against `EDITOR_KINDS`, the command as a non-empty string, no unknown keys |
| `src/main/db/repositories/settings.ts` | Merges `editor` field by field, on read as well as on write |
| `src/main/ipc/register.ts` | Layers `editorHandlers` over the Electron-free map, after `dialogHandlers` and `themeHandlers` |

The confinement rule itself is **not** here: it is `resolveInWorkdir` in
`src/main/executor/paths.ts`, imported unchanged. That module already handles
`..`, an absolute path outside the folder, a symlink to a file or a directory, a
file that does not exist yet, and a working directory that has vanished — the
four ways out its own header tabulates.

## Database

No new table and no migration. `AppSettings` is one JSON row per user
(`settings.data`), so `editor` appears inside the existing blob.

| Table | Column | Type | Notes |
|---|---|---|---|
| `settings` | `data` | JSON | Gains `editor: { kind, command }`. Additive: `withDefaults` merges the stored row over `DEFAULT_APP_SETTINGS` with `editor` merged field by field, so a row written before S5.7 reads back complete and no migration runs |

## IPC handlers

| Channel | Input | Output | Errors |
|---|---|---|---|
| `system.openInEditor` | `{ path, line?, chatId? }` | `void` | `validation` + `{ reason: 'editor_path_not_absolute' }` for a missing, blank or relative path; `validation` + `{ reason: 'editor_path_outside_workdir' }` when the named chat has a folder and the path resolves outside it (or the folder has vanished); plain `validation` for a `line` that is not a positive integer; `internal` with `OPEN_IN_EDITOR_UNAVAILABLE` when the editor is a URL scheme and no overlay is layered |
| `settings.update` | `{ patch: { editor?: Partial<EditorSettings> } }` | `AppSettings` | `validation` for an `editor` that is not an object, an unknown key inside it, a `kind` outside `EDITOR_KINDS`, or a `command` that is not a non-empty string |

Order matters inside the handler and is asserted: **the path is validated before
the setting is read**, so a refusal says the same thing whichever editor is
configured and whichever build is running.

A `chatId` naming a chat that no longer exists is treated as *no confinement*
rather than as an error: the message may still be on screen in a window that has
not caught up, and rule 1 still applies.

## Events emitted

None. Opening a file changes nothing the backend owns.

## Filesystem

Nothing is written. The module reads the chat's working directory through
`realpathSync` (inside `resolveInWorkdir`) and never touches the target file —
it does not even check that it exists, because an editor opens a missing path as
an empty buffer and a refusal would turn a stale path in an old message into an
error the user cannot act on.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `electron` `shell.openExternal` | Handing `vscode://file/<path>:<line>` and `cursor://file/…` to the platform | Confined to `src/main/ipc/editor.ts`. It resolves when the **platform accepted** the URL, not when an editor appeared, and on macOS it *rejects* when no application is registered for the scheme — which is exactly why `e2e/editor.spec.ts` exercises the round trip with a custom command instead: asserting on the URL branch would be asserting on what is installed on the machine running the tests |
| `node:child_process` `spawn` | Running a custom command line | `/bin/sh -c` with the path already single-quoted; `detached: true` and `unref()` so the editor outlives the call and does not hold the app's event loop; `stdio: 'ignore'` because there is no output to collect; an `error` listener that swallows, so a failed spawn cannot take the app down as an unhandled event. Nothing is awaited — the process starting is the whole answer |
| `node:path` `isAbsolute` / `resolve` | Rule 1, and normalising a path when no folder confines it | The renderer cannot use this module at all (no Node types there), which is why `file-refs.ts` reimplements normalisation lexically. The two are allowed to differ in one direction only: the renderer may draw a chip the backend then refuses, never the reverse |

### The URL, precisely

`vscode://file` + the absolute path with **each segment** percent-encoded +
`:<line>` only when there is a line. Encoding the whole path with
`encodeURIComponent` would eat the separators; not encoding at all lets a `#` or
a `?` in a directory name truncate the URL. A trailing bare colon is not "no
line" to the scheme — it is part of the filename — so the suffix is omitted
entirely rather than left empty.

### The quoting, precisely

`shellQuote` wraps in single quotes and rewrites `'` as `'\''` (close, escaped
quote, reopen), which is the only escape POSIX `sh` allows inside single quotes.
This is the boundary that keeps `notes.md; rm -rf ~` a filename rather than a
second command — the path reaches this function from a language model by way of
the renderer.
