# editor — Context

## Problem

A group of agents discusses code, an executor changes it, and the transcript
fills up with paths: `src/main/index.ts:42` in a reply, a diff header over a
patch, a `read_file(src/a.ts)` card. Every one of them is somewhere the user
wants to *be*, and until S5.7 the only way to get there was to read the path off
the screen and type it into an editor.

This feature makes those paths clickable. One click opens the file, at the line
if the reference carried one, in VS Code, Cursor or any editor that can be
launched from a command line. It is PLAN.md's "Future extension", point 3, step
one; step two — a VS Code extension embedding the chat panel — waits for the
backend to be reachable from outside Electron and is scheduled with the server
work.

## Scope

- `AppSettings.editor`: `{ kind: 'vscode' | 'cursor' | 'custom', command }`,
  default VS Code with the template `code -g {path}:{line}`, validated in the
  settings handler and edited in Settings → Developer → Editor.
- `system.openInEditor({ path, line?, chatId? })`: the one backend method, with
  its two path rules (absolute; inside the chat's folder when there is one) and
  its two implementations — a URL scheme through `shell.openExternal`, or a
  command line through `node:child_process`.
- `src/main/editor/open.ts`: the whole decision — confinement, the URL, the
  command template's expansion and its quoting — in a module that imports no
  electron.
- `src/main/ipc/editor.ts`: the overlay that owns the `shell.openExternal` call.
- `src/renderer/src/components/chat/file-refs.ts`: the pure detector that finds
  `path:line` and `path` tokens in a message body and resolves them against the
  chat's folder, plus `absoluteInWorkdir`, which the other three surfaces use.
- Since S5.10 a fifth surface, outside the transcript: the **goal chip** in the
  chat header, which opens a `document` goal's deliverable once the file exists.
  It calls the same `lib/editor.ts` helper, is a button only while there is
  something to open, and paints red for the same 2.5 s on a refusal. The chip
  itself belongs to [`chats`](../chats/context.md).
- The four clickable surfaces in the transcript: the `FileRefPart` chip, a token
  the detector found in the body text, the `DiffPart` header path, and the "open"
  icon on a `read_file` / `write_file` / `edit_file` card.

## Out of scope

| Not here | Who owns it |
|---|---|
| The transcript itself — the message list, the rows, the code blocks | [`chats`](../chats/context.md). This feature adds behaviour to components that live there |
| The executor's tools, the permission prompt and the `DiffPart`s a turn appends | [`executor`](../executor/context.md). This feature reuses its confinement rule (`executor/paths.ts`) and makes its output clickable |
| `Chat.workdir`, its picker and its validation | [`chats`](../chats/context.md), S5.2 `[x]` |
| Emitting a `FileRefPart` from the backend | Nobody yet. The part type has existed since S1.1 and nothing writes one; the chips a user actually sees come from the text detector. See the Phase 6 backlog |
| A VS Code extension that embeds the chat panel | PLAN.md point 3 step two, scheduled with the server work (STEPS.md Phase 6) |
| Opening a **folder**, a URL, or a file in a chat that is not bound to a folder when the reference is relative | Nobody. A relative path with no folder has nothing to resolve against |

## Dependencies

| Feature | What this one needs from it |
|---|---|
| [`chats`](../chats/context.md) | `Chat.workdir` — what a relative reference resolves against and what an absolute one is confined to — and the transcript components the chips live in |
| [`executor`](../executor/context.md) | `resolveInWorkdir` in `src/main/executor/paths.ts`, reused verbatim as rule 2; and the `DiffPart`s and file tool calls that are now clickable |
| [`backend-client`](../backend-client/context.md) | The `BackendClient` contract, the handler registry, and the `src/main/ipc/` overlay mechanism that `dialogs.ts` and `theme.ts` established |
| [`i18n`](../i18n/context.md) | Three `chat.*` keys, seven `settings.developer.editor*` keys and two `errors.*` reasons |

Nothing depends on this feature in return: every surface it touches works without
it, one click less conveniently.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| Two named editors as **URL schemes**, everything else as a **command template** | Only a command; only URLs; a list of known editors with a command each | A URL needs nothing on the `PATH`, which is the common failure of `code` (the user never ran "Install 'code' command in PATH"). But a URL scheme only exists for editors that register one, so the escape hatch has to be the interface every editor has — a command line |
| The setting lives in **Settings → Developer** | Appearance & language; a section of its own | It is for someone who reads code out of a chat, and its custom mode is a shell command. Developer is already where the things that assume a terminal live, and a section of its own for two controls would be a nav entry that is empty most of the time |
| `{path}` is substituted **already quoted** | Leave quoting to the template author | `code -g {path}:{line}` is the template people will copy, and it is correct for `/Users/ada/My Projects/a.ts` only if the substitution quotes. A template that quotes the placeholder itself would double-quote, which is why the hint says not to |
| The custom command runs through `/bin/sh -c` | Parse the template into argv and `spawn` without a shell | The template is a *command line* — the thing users paste out of an editor's documentation, complete with flags and sometimes a pipe. Parsing it into argv would be a second, worse shell. The path is the only untrusted part and it is quoted before it goes in |
| The path must be **absolute** | Accept a relative path and resolve it in the backend | The renderer already resolved the token against the folder in order to decide whether to *draw* a chip at all. Sending the answer rather than the question means one resolution, in one place, and a refusal (`editor_path_not_absolute`) that names a real client bug |
| Confinement reuses `executor/paths.ts` rather than a new check | A simpler prefix comparison in the editor module | Symlinks, `..` and a file that does not exist yet are already handled correctly there. A second implementation is a second chance to get the symlink case wrong |
| Confinement applies **only when the call names a chat with a folder** | Always require a folder; never confine | A path in a message is *model* output and must be confined — that is the whole point. A call with no chat is the user asking for a specific file, and refusing to open their own `~/notes.md` because the chat is unbound would be second-guessing a direct instruction |
| The detector is **lexical** and never stats a file | Ask the backend whether each token exists before drawing it | The renderer has no filesystem and one IPC round trip per token in every message is not a budget worth spending on underlining. The backend re-resolves through `realpathSync` on the click, which is where correctness actually matters |
| A relative token must end in a **real extension** | Treat every token containing a `/` as a path | Otherwise `read/write` and `and/or` in prose become buttons. The cost is that `Makefile` and `LICENSE` are never chips, which is the right way round: a missed path costs a copy and paste, a wrong one is a button that opens a file nobody mentioned |
| Detection is on **every** message body, the user's included | Agent messages only, as S5.7 words it | The mechanism is "a path, in a chat bound to a folder" and the sender does not change what the token means — a user pasting a stack trace wants the same click. It also makes the behaviour observable end to end without a live model, which is what `e2e/editor.spec.ts` turns on |
| Inline code is a chip when it is **entirely** one reference; a fenced block never is | Chip every path inside every code block | `` `src/a.ts:42` `` is how a model writes a path more often than not. A fenced diff or directory listing would become forty buttons, and it is a `CodeBlock` with its own copy control already |
| The chip's click **opens**; the S5.5 copy-on-click is gone | Keep both, split by modifier or by a second control | S5.5's copy was explicitly a placeholder for this step. A 20-pixel target with two meanings is worse than either, and the reference is still selectable text in the message it came from |
| A failed open paints the chip, and nothing else | A toast; a system notice in the transcript | The user clicked a specific control; the answer belongs on that control. A notice in the transcript would be the app writing into the conversation about a click |
| `system.openInEditor` resolves `void` | Resolve with whether an editor actually appeared | No platform reports that. `shell.openExternal` says the URL was accepted and a spawned command says a process started; waiting for more would wait forever |

## Open questions

- **Nothing emits a `FileRefPart`.** The part type is rendered and the chip is
  the same component either way, but every chip a user sees today comes from the
  text detector. A turn that reported the files it read as parts would be more
  precise than a regular expression over prose.
- **The detector cannot see a file that does not exist, or one that does.** It
  draws a chip on `src/typo.ts:3` and refuses `Makefile`. A cheap backend
  `exists` batch per message, cached per chat, would fix both directions.
- **Neither editor is verified to be installed.** A `vscode://` URL on a machine
  without VS Code rejects, the chip goes red for two seconds, and nothing tells
  the user to change the setting beyond the tooltip. Probing at settings time
  would be friendlier.
- **A path in a chat with no folder is never clickable**, even when it is
  absolute and unambiguous. Rule 2 could be relaxed to "confine only relative
  resolution", at the cost of letting a model's absolute path be one click from
  opening.
- Whether "open" should also mean "reveal in Finder" for a directory, which
  neither URL scheme does well.
