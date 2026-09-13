# memory — Frontend

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/components/agents/memory-panel.tsx` | The whole panel: the entry list (with `MEMORY.md` as its first row), the file editor, delete, and the three empty states |
| `src/renderer/src/components/agents/agent-editor.tsx` | The "Memory across chats" block: the toggle bound to `draft.memoryEnabled`, and the panel under it |
| `src/renderer/src/stores/memory.ts` | The store, plus the pure `isDirty` rule |

The panel has no presence in the chat UI. What a user sees of memory during a
conversation is the ordinary tool card the transcript already draws for
`memory_save` and `memory_search` ([`chats`](../chats/frontend.md)).

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| `memory` | `agentId` | `string \| null` | Whose memory is loaded; the panel is reused for every agent |
| `memory` | `entries` | `MemoryEntry[]` | Backend-owned mirror of the index's entries, in index order |
| `memory` | `status` | `'idle' \| 'loading' \| 'ready' \| 'error'` | Load state of the list |
| `memory` | `error` / `errorCode` | `string?` / `BackendErrorCode?` | Developer detail plus the code the UI translates |
| `memory` | `openPath` | `string \| null` | The file the editor is showing |
| `memory` | `draft` | `string` | The editor's working copy |
| `memory` | `saved` | `string` | What was last read or written, so `dirty` is a comparison rather than a flag |
| `memory` | `saving` | `boolean` | A write is in flight |

`isDirty({ openPath, draft, saved })` is exported and pure; it is what disables
Save. There **is** a draft here, unlike `stores/skills.ts`, because these files
are genuinely edited in the app — and writing on every keystroke would race a
running turn that is appending to the same index.

Both `load` and `open` check that the answer still belongs to the question before
applying it: selecting another agent, or another note, while a read is in flight
must not overwrite the newer state with the older answer.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `memory.list` | `MemoryPanel` on mount and after every write or delete | The entry list |
| `memory.read` | Clicking a row or the `MEMORY.md` row | Load the file into the editor |
| `memory.write` | Save | Persist the edited file |
| `memory.delete` | The trash icon on a row | Remove one note and its index line |

No subscriptions. `memory_save` emits no event by design (see
[`context.md`](./context.md)); the panel re-reads when it opens, which is the
moment the user asked to see it.

## Interaction states

| State | What the user sees |
|---|---|
| idle | The entry list with `MEMORY.md` first, showing the entry count, and one row per note with its title and date |
| loading | The list is empty and the empty state is withheld until `status !== 'loading'`, so a slow read never flashes "nothing remembered" |
| streaming | Not applicable |
| empty | "Nothing remembered yet" under the `MEMORY.md` row — the index is still openable, because it is the thing every prompt carries |
| unsaved agent | "Save the agent first": a draft has no id, so there is no memory folder to read |
| editing | The path, a Cancel and a Save button, and a monospaced textarea. Save is disabled until the draft differs from what was read |
| error | One translated line, under the editor or under the list |

The toggle above the panel is independent of it: turning memory **off** stops the
tools being attached and the index being injected, but leaves every file in
place, so it can be turned back on without losing anything.

## Copy and i18n

New keys under `agents.*`: `memoryEmptyTitle`, `memoryEmptyDescription`,
`memoryUnsavedTitle`, `memoryUnsavedDescription`, `memoryEntryCount`
(`{{entries}}`), `memoryContent` (the textarea's accessible name).
`agents.memoryComingSoon` was removed — the panel is real now.

`agents.memoryAcrossChats` and `agents.memoryToggle` already existed and are
unchanged; `common.save`, `common.cancel` and `common.delete` are reused.

Note that the **file contents** are never translated: they are the agent's own
markdown, shown verbatim.

## Accessibility and keyboard

- Each row is a `<button>`; the delete action is a separate `IconButton` with a
  translated `label`, so it has an accessible name and a tooltip rather than an
  icon alone.
- The textarea carries `aria-label={t('agents.memoryContent')}`, because its
  label is the path above it rather than a `<label>` element.
- The toggle is the shared `Toggle` (`role="switch"`, `aria-checked`), wrapped in
  a span that carries the test id — the same pattern `McpCard` uses.
- Dates are rendered as `YYYY-MM-DD`, which needs no translation and sorts
  visually.
