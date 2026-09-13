# editor — Frontend

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/components/chat/file-refs.ts` | The pure detector and resolver: `findFileRefs(text, workdir)`, `absoluteInWorkdir(workdir, token)`, `splitLineSuffix`. No DOM, no `node:path`, no filesystem |
| `src/renderer/src/components/chat/file-ref-chip.tsx` | The chip. Opens the file on click; renders as plain text when there is no absolute path to open; paints itself danger for 2.5s when the call is refused |
| `src/renderer/src/components/chat/markdown.tsx` | Decorates `p` / `li` text children with chips (after the mention split) and turns an inline code span that is entirely one reference into a chip |
| `src/renderer/src/components/chat/diff-block.tsx` | The header is a flex row of two buttons: the expand toggle, and the path, which opens the file |
| `src/renderer/src/components/chat/tool-card.tsx` | An "open" icon beside the expand toggle for a `read_file` / `write_file` / `edit_file` card whose path resolves |
| `src/renderer/src/components/chat/tool-call.ts` | `filePath` on `ToolCallDescription` and `openableFilePath(part)` — which cards get that icon |
| `src/renderer/src/components/chat/message-item.tsx` | Reads the chat's folder and passes `chatId` + `workdir` to all four surfaces |
| `src/renderer/src/lib/editor.ts` | `openInEditor({ path, line, chatId })` — the `BackendClient` call, and nothing else |
| `src/renderer/src/pages/settings/developer-section.tsx` | The Editor block: a `SegmentedControl` for the kind, and a monospace `Input` for the template shown only for `custom` |
| `src/renderer/src/pages/settings/editor.ts` | `applyEditorSetting(patch)` — the one place the controls write through, mirroring `./theme.ts` |
| `src/renderer/src/i18n/errors.ts` | The two new `ValidationReason`s |

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| `settings` | `settings.editor` | `EditorSettings` | Server-owned. Read by the Editor block; written one field at a time by `setEditor(Partial<EditorSettings>)` |
| `chats` | `chats[].workdir` | `string \| null` | Server-owned. Read per row through the new `useChatWorkdir(chatId)` selector |

Local UI state is two booleans and a string: the chip's transient `failed` flag,
the diff block's `open`, and the command field's `draft` (committed on blur or
Enter, snapped back to the stored value when blank).

`useChatWorkdir` is a selector rather than a prop threaded through
`MessageList`, for the reason `useAgentPresence` is: every row needs it, the row
already has the `chatId`, and a string is a stable value so a row re-renders only
when the binding really changes.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `system.openInEditor` | `lib/editor.ts`, from the chip, the diff header and the tool card | Open one file at one line |
| `settings.update` (`editor` patch) | `stores/settings.ts` `setEditor`, via `pages/settings/editor.ts` | Persist the kind or the command template |
| `settings.get` | The existing bootstrap load | Brings `editor` with the rest of the row |

No new subscription. Nothing about opening a file changes server state, so there
is nothing to hear about.

## Interaction states

| State | What the user sees |
|---|---|
| idle | A path in a message is a mono chip with a file icon; hovering turns it accent and the tooltip says "Open this file in your editor" |
| loading | None. The call resolves as soon as the platform accepts it, which is faster than a frame; a spinner would flash |
| streaming | Chips appear mid-stream as the tokens that form them arrive, and are re-derived on each re-render; a half-typed path simply does not match yet |
| empty | A chat with no working directory draws no chips, no clickable diff header and no "open" icon — every surface falls back to the plain S5.5 rendering |
| error | The chip turns red with a warning triangle for 2.5 seconds, tooltip "Could not open this file…"; the diff header and the tool icon swallow the failure, because the path they show came from the backend and a refusal there is a bug rather than something the user can act on |
| settings error | A refused `settings.update` lands in the settings store's `error`, which Settings → Developer already renders above the block |

## Copy and i18n

Three keys under `chat.*`:

| Key | Where |
|---|---|
| `chat.fileRefTitle` | The chip's tooltip. **Reworded** in S5.7 — it used to say "Copy this path" |
| `chat.fileRefFailed` | The chip's tooltip while it is red |
| `chat.openInEditor` | The diff header's tooltip, and the tool icon's `aria-label` and tooltip |

Seven under `settings.developer.*`: `editor`, `editorHint`, `editorVscode`,
`editorCursor`, `editorCustom`, `editorCommand`, `editorCommandHint`. The two
editor names are brand marks and are the same string in both locales.

Two under `errors.*`: `editor_path_not_absolute` and
`editor_path_outside_workdir`, reached through `validationReasonMessage`.

`{path}` and `{line}` are written with **single** braces in the hint, not
i18next's `{{…}}`: they are literal placeholder text the user types into a
command, not interpolation.

The path itself, the command template and the URL are never translated. They are
data, the same rule the working-directory chip and the diff patch follow.

## Accessibility and keyboard

- Every surface is a real `<button>`, reachable by Tab and activated by Enter or
  Space, with a visible `focus-visible` ring.
- The diff header became **two** buttons (expand, and the path) rather than a
  button inside a button, which is invalid and unreachable by keyboard. The
  "expand / collapse" word at the end of the row is the third, so the toggle is
  reachable from either end of the line.
- The tool card's icon has an `aria-label` as well as a `title`, because it has
  no text.
- A chip that cannot be opened is a `<span>`, not a disabled button: it is text
  that happens to look like a path, and it should not be a tab stop.
- `data-openable` on the chip says which of the two it is, so an end-to-end spec
  can assert it without reading copy.
