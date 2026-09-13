# editor — Implementation

## Approach

Three pieces, and the seam between them is the interesting part.

**The decision** is `src/main/editor/open.ts`. It takes the call's input and the
application context, applies the two path rules, reads `AppSettings.editor`, and
returns a *plan*: either `{ kind: 'url', url }` or `{ kind: 'command', command }`.
It does not open anything. Everything that could be got wrong — confinement,
percent-encoding, shell quoting, the missing-line default — is here, once, and it
imports no electron.

**The two runners** are `handlers/system.ts` and `src/main/ipc/editor.ts`. Both
ask `planOpenInEditor` and then act on the answer. The Electron-free handler runs
a `command` plan with `node:child_process` and rejects a `url` plan with
`OPEN_IN_EDITOR_UNAVAILABLE`; the overlay runs a `command` plan the same way and
hands a `url` plan to `shell.openExternal`. This makes `system.openInEditor` the
first backend method that is only *conditionally* window-system: with a custom
editor configured it works in a server build unchanged.

**The detector** is `src/renderer/src/components/chat/file-refs.ts`, pure text
with no DOM and no `node:path` (the renderer project has no Node types).
`findFileRefs(text, workdir)` returns the references in a body along with their
offsets and their absolute paths; `absoluteInWorkdir(workdir, token)` is the
resolver on its own, which the diff header and the tool card use because they
already know they are holding a path.

Four surfaces in the transcript — and, since S5.10, the chat header's goal chip —
call one helper, `src/renderer/src/lib/editor.ts`, which is the
`BackendClient` call and nothing else.

## Data flow

The main path — a path in an agent's reply:

```
message body text
  → MessageItem reads Chat.workdir from the chats store by chatId (useChatWorkdir)
  → <Markdown workdir chatId> decorates p / li children
  → findFileRefs(segment, workdir)      pure, lexical, offsets + absolute path
  → <FileRefChip absolute chatId>
  → click → lib/editor.ts openInEditor({ path, line, chatId })
  → BackendClient.invoke('system.openInEditor')
  → IPC → registerIpc's table (editorHandlers layered over the stub)
  → planOpenInEditor(ctx, input)
       resolveEditorTarget  → absolute? → chat's workdir? → resolveInWorkdir (realpath)
       ctx.repos.settings.get().editor
  → shell.openExternal('vscode://file/…:42')      or   spawn('/bin/sh', ['-c', …])
  → resolves void; the chip does nothing further
```

The refusal path, which is the one worth tracing twice:

```
click → invoke → resolveEditorTarget throws BackendFailure('validation', …,
        { reason: 'editor_path_outside_workdir' })
  → ipc-protocol serialises { ok: false, error }
  → BackendClientError in the renderer
  → FileRefChip catches, paints itself danger for 2.5s, tooltip = chat.fileRefFailed
```

The settings path:

```
Settings → Developer → Editor
  SegmentedControl / command Input (commits on blur or Enter)
  → pages/settings/editor.ts applyEditorSetting(patch)
  → settings store setEditor(Partial<EditorSettings>)
  → settings.update { patch: { editor } }   →  assertEditorPatch  →  repository
       merges editor field by field, like timeouts
  → the store mirrors the stored answer; nothing repaints
```

## Key types and contracts

In `src/shared/types.ts`:

| Type | Shape |
|---|---|
| `EditorKind` | `'vscode' \| 'cursor' \| 'custom'` |
| `EDITOR_KINDS` | The three, in the order the control shows them |
| `EditorSettings` | `{ kind: EditorKind; command: string }` |
| `DEFAULT_EDITOR_COMMAND` | `'code -g {path}:{line}'` |
| `AppSettings.editor` | `EditorSettings`; `DEFAULT_APP_SETTINGS.editor` is `{ kind: 'vscode', command: DEFAULT_EDITOR_COMMAND }` |
| `AppSettingsPatch.editor` | `Partial<EditorSettings>`, merged field by field |
| `VALIDATION_REASONS` | Gains `editor_path_not_absolute` and `editor_path_outside_workdir` |

The settings migration is additive: the repository merges the stored row over
`DEFAULT_APP_SETTINGS` on **read** as well as write, `editor` field by field, so
a row written before S5.7 comes back with the default editor and a row written by
a newer version with half an `editor` object still comes back complete.

| Channel / method | Request | Response | Notes |
|---|---|---|---|
| `system.openInEditor` | `{ path: string; line?: number; chatId?: string }` | `void` | `validation` with `editor_path_not_absolute` / `editor_path_outside_workdir`; `internal` (`OPEN_IN_EDITOR_UNAVAILABLE`) for a URL kind outside the Electron transport |
| `settings.update` | `{ patch: { editor?: Partial<EditorSettings> } }` | `AppSettings` | `validation` for an unknown kind, a blank or non-string command, a non-object `editor`, or an unknown key inside it |

No new event: opening a file changes nothing the backend owns, so there is
nothing to broadcast.

## Tests

| File | Covers |
|---|---|
| `src/main/editor/open.test.ts` | 22 cases: both path rules against a real temporary folder (relative, empty, outside, `..`, a symlink out, no folder, no chat, an unknown chat, a bad line), the two URLs and their encoding, the command expansion (a space, a single quote, a `;`, a missing line, repeated placeholders), and the three plans |
| `src/main/handlers/handlers.test.ts` | `system.openInEditor`: the URL kind's rejection, a custom command really running (a marker file the child writes), and the two refusals; and `settings.update`'s `editor` validation — the three kinds, the field-by-field merge, an unknown kind, a blank command, a non-object patch |
| `src/renderer/src/components/chat/file-refs.test.ts` | 28 cases: `absoluteInWorkdir` (inside, outside, `..`, a prefix sibling, a trailing slash, Windows, no folder) and `findFileRefs` (a line, no line, absolute, a URL, `1.2:3`, `v1.2.3`, an email, prose with a slash, punctuation, offsets, several in a line, no folder, an extensionless name) |
| `src/renderer/src/components/chat/tool-call.test.ts` | `filePath`: the three tools that get an "open" icon, the four that do not, an MCP tool of the same name, a missing / blank / non-string argument |
| `src/renderer/src/stores/settings.test.ts` | The default, the field-by-field patch, the exact `settings.update` input, and a rejected write |
| `src/shared/contracts.test.ts` | `DEFAULT_APP_SETTINGS.editor`, `EDITOR_KINDS`, and `system.openInEditor` in `BACKEND_METHODS` |
| `e2e/editor.spec.ts` | Offline, always runs: the Editor block's three kinds and its conditional command field, both surviving a restart; a chip drawn for a path inside the folder and none for `/etc/passwd:1` or `1.2:3`; the backend really running the call the chip would make (a custom command writing a marker); the two refusals; and no chip at all once the folder is cleared |

## Known limitations and TODOs

- **The click itself is not driven end to end.** `system.openInEditor` ends in
  `shell.openExternal`, which would launch the developer's real editor mid-run,
  and `window.witena` is a `contextBridge` object whose methods cannot be
  replaced from the page, so there is no way to intercept the call. `e2e/` asserts
  the chip is a real button carrying the path and line, and separately that the
  backend accepts exactly that call — see the spec's header.
- **The detector is a heuristic.** It misses an extensionless filename and a path
  containing a space, and it draws a chip on a path that does not exist. Each is
  written up in `context.md`'s open questions.
- **No editor is probed.** Choosing Cursor on a machine without Cursor is
  accepted, and the failure surfaces two seconds at a time on a red chip.
- **`{line}` defaults to 1** when a reference carries no line, because the
  default template welds `:{line}` on. A template that wanted "no line at all"
  cannot express it.
