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
- The renderer stores behind all of it (`chats`, `messages`, `presence`,
  `agents`) and the single event subscription that feeds them.
- `ensureDefaultAgent`: the one bootstrap agent a new chat is given, so the first
  conversation is possible before S2.1 exists.

## Out of scope

| Not here | Owned by |
|---|---|
| Who speaks, in which order, and for how many rounds | `orchestration` (S2.3) |
| What one agent does during its turn | `agent-turn` |
| Creating and editing agents | `agents` (S2.1) |
| Adding, removing and reordering members; persisting `ChatSettings` | S2.2 |
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
repository and emits the events these stores reduce; `agents` (S2.1) replaces
`ensureDefaultAgent`; S2.2 fills in the member panel's actions.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| `chats.create` adds a bootstrap agent when the agents table is empty | Let a chat exist with no members; ship S2.1 first | A chat with no members cannot answer, and the step's acceptance is a working conversation. `ChatInput` carries no member list, so the handler is the only place that can fill one in. It becomes the empty-library fallback in S2.2 |
| `chats.members.list` was added to `BackendApi` | Put a member count on `Chat`; show every agent as a member | The contract had `members.set` but no getter, and both columns need the membership. A derived field on the domain type would be a lie the moment S2.2 lets membership change |
| The chat list groups by **calendar day** | "within 24 hours" | A message sent at 23:50 has to read as *yesterday* the next morning. The rule is in `groupChats`, with the 23:50 case as its own test |
| Delete confirms in place ("click again"), rename edits in place | A modal dialog | Both are one-click-recoverable actions on a list row; the pattern already exists in Settings → Providers |
| Rename cancels on blur rather than committing | Commit on blur | A click elsewhere is far more often "never mind" than "save this" |
| Chats are loaded with one `chats.members.list` call each | A batched method; a count column | N+1 over local IPC costs nothing at desktop list sizes, and it keeps the contract honest. S2.2 revisits it if a list ever grows enough to notice |
| `selectedId` is not persisted | Remember the last open chat | A restart opening on "no chat selected" is predictable; restoring a chat that was mid-run when the app died is not |

## Open questions

- Whether the member count belongs on `Chat` after all, once S2.2 makes
  membership mutable and the left column has to react to it live.
- Whether `messages.list` should return oldest-first for the first page, given
  that every caller reverses it. Changing it would change a contract that already
  has a cursor semantics written around "newest first".
