# chats — Context

## Problem

A conversation needs somewhere to live. This feature is the container: the list of
chats in the left column, the create / rename / delete actions on it, and the
persistence of every message that is ever sent — the transcript that
`orchestration` schedules against and `agent-turn` reads to rebuild an agent's
view.

It is the feature the user meets first. Before S1.7 the left column was an empty
state and the composer was disabled; after it, pressing "+" produces a chat that
can hold a real conversation and still holds it after a restart.

## Scope

- `chats.*` handlers: list, get, create, update (rename and settings), delete,
  and the two membership methods.
- `messages.list`: the transcript page the chat view opens on, newest first with
  a message-id cursor.
- The left column: grouping by Today / Yesterday / Earlier, selection, inline
  rename, two-step delete.
- The middle column's message list: avatars with presence dots, author name,
  model badge, markdown body, collapsible reasoning, streaming cursor, dimmed
  `passed`, red hint on `error`.
- The renderer stores behind all of it (`chats`, `messages`, `run`, `presence`,
  `agents`, `providers`) and the single event subscription that feeds them.
- The right column (S2.2): the member picker, removing a member, drag-to-reorder
  the speaking order, and the group-settings block bound to `ChatSettings`.
- The message row's labels fed by the run (S2.3): `Round n`,
  `Replying to @x` from `Message.inReplyTo`, and `@Name` highlighted in the body.
- `ensureDefaultAgent`: the bootstrap agent a chat is given **only** while the
  agent library is empty, so a fresh install can hold a conversation before
  anyone opens the Agents page.

## Out of scope

| Not here | Owned by |
|---|---|
| Who speaks, in which order, and for how many rounds | [`orchestration`](../orchestration/context.md) |
| What one agent does during its turn | `agent-turn` |
| Creating and editing agents | [`agents`](../agents/context.md) (S2.1) |
| Presence beyond `working` / `available` around a turn | `presence` (S2.4) |
| Search in the chat list, generated titles | S4.3 |
| Syntax highlighting, tool cards, `@` autocomplete | S2.5 |
| Virtualized message list, upward paging | S2.5 |

## Dependencies

| Feature | What this one needs from it |
|---|---|
| [`database`](../database/context.md) | `ChatRepository` (list ordered by `updatedAt`, membership in one transaction) and `MessageRepository` (the `seq` ordering and the `before` cursor) |
| [`backend-client`](../backend-client/context.md) | `BackendClient`, the `BackendApi` contract and the typed event union |
| [`providers`](../providers/context.md) | A provider with at least one model, or `chats.create` has nothing to bind the bootstrap agent to |
| [`ui-shell`](../ui-shell/context.md) | `Column`, `PageHeader`, `Avatar`, `PresenceDot`, `Badge`, `EmptyState` and the design tokens |
| [`i18n`](../i18n/context.md) | Every string under `chat.*` and `common.you`; `translateNotice` for stored system notices |

Depending on it in return: `orchestration` persists through the same message
repository, emits the events these stores reduce, and reads `chat_members` — in
`position` order — once **per run**, so a membership or settings change lands at
the next round boundary rather than mid-turn.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| `chats.create` takes `memberAgentIds`, and only falls back to the bootstrap agent while the agents table is empty | Always add the first agent; never add anyone | Once the user owns agents, deciding who is in a chat is theirs. The fallback is kept because it is the only thing that makes the *first* chat of a fresh install answerable |
| `ChatCreateInput` carries `memberAgentIds` rather than `Chat` carrying members | Put a member list on `Chat`; save the chat and then its members | Membership is a separate table and not a property of the chat row, but a chat created from the picker must be born with its members rather than saved twice |
| `chat.send` rejects with `validation('chat has no members')`, and the composer stays enabled | Disable the composer; run with nobody and finish silently | A disabled composer does not say *why*. The rejection prints one line under the box and the member panel prints the fix |
| `ChatPatch.settings` is a partial that the backend merges | Send the whole `ChatSettings` from every control | Two controls changed quickly would otherwise overwrite each other, and the caller would have to hold a copy of the stored object |
| Every group-settings control persists on change, with no Save button | A Save button; a debounce | Each control is one field of one row. A select the user changed and then closed the app on must not quietly have been forgotten |
| Reordering uses the native HTML5 drag events | A drag-and-drop library | A handful of rows in a window that is always Chromium. The library would add a package, a provider component and its own keyboard model; the only part that can silently be wrong is the index arithmetic, which lives in `lib/reorder.ts` and is unit-tested |
| Add / remove / reorder all end in one `chats.members.set` with the whole array | Narrower add / remove / move methods | The array index *is* `position`. Three narrower calls would each have to read the current order first, and would race the `chat.updated` that follows |
| `chats.members.list` was added to `BackendApi` | Put a member count on `Chat`; show every agent as a member | The contract had `members.set` but no getter, and both columns need the membership. A derived field on the domain type would be a lie the moment S2.2 lets membership change |
| The chat list groups by **calendar day** | "within 24 hours" | A message sent at 23:50 has to read as *yesterday* the next morning. The rule is in `groupChats`, with the 23:50 case as its own test |
| Delete confirms in place ("click again"), rename edits in place | A modal dialog | Both are one-click-recoverable actions on a list row; the pattern already exists in Settings → Providers |
| Rename cancels on blur rather than committing | Commit on blur | A click elsewhere is far more often "never mind" than "save this" |
| Chats are loaded with one `chats.members.list` call each | A batched method; a count column | N+1 over local IPC costs nothing at desktop list sizes, and it keeps the contract honest. S2.2 revisits it if a list ever grows enough to notice |
| `selectedId` is not persisted | Remember the last open chat | A restart opening on "no chat selected" is predictable; restoring a chat that was mid-run when the app died is not |

## Open questions

- Reordering is mouse-only. `ChatRunner` reads `position` every round, so the
  order matters more since S2.3 and a keyboard path for it is still missing.
- Whether the member count belongs on `Chat` after all: membership is now
  mutable and the left column re-reads `chats.members.list` per chat to follow it.
- Whether `messages.list` should return oldest-first for the first page, given
  that every caller reverses it. Changing it would change a contract that already
  has a cursor semantics written around "newest first".
