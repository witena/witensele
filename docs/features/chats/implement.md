# chats — Implementation

## Approach

Three layers, each ignorant of the one above it:

1. **Storage.** `ChatRepository` and `MessageRepository` (S1.2) already hold
   everything: chats ordered by `updatedAt`, membership replaced in one
   transaction, messages ordered by a per-chat `seq`.
2. **Handlers.** `src/main/handlers/chats.ts` is validation plus events. It owns
   three behaviours that are not CRUD: `chats.create` decides who a new chat
   starts with, `chats.delete` stops the chat's run before the rows go away, and
   `chat.send` refuses a chat with no members.
3. **Renderer.** Six zustand stores mirror the backend and one module
   (`lib/event-bridge.ts`) subscribes to the backend once and fans every event
   into them. Components read stores and call store actions; none of them calls
   `BackendClient` directly.

The rule that shapes the renderer half: **backend-owned state is never edited
optimistically.** An action calls `invoke` and the store applies either the
returned value or the event that follows — which is why a message sent during a
run still appears instantly (the backend stores it and emits `message.created`
before deciding what to do with it) without the store having to guess.

## Data flow

### Creating a chat

```
"+" button
  → useChatsStore.create()
  → invoke('chats.create', { input: {} })
  → handler: initialMembers(ctx, undefined)
               agents table empty → ensureDefaultAgent(ctx), that agent
               otherwise        → []          // the user picks in the panel
             chats.create() + chats.setMembers()
             emit chat.updated
  → store: applyUpdated(chat), select(chat.id), loadMembers(), agents.load()
  → the row appears under "Today"; the composer is usable, but a send is
    refused until the chat has a member
```

### Changing the members

```
"+ Add" → pick an agent      |  row "×"                |  drag a row onto another
  memberIds + [agentId]      |  memberIds − agentId    |  reorder(memberIds, from, to)
  → useChatsStore.setMembers(chatId, agentIds)
  → invoke('chats.members.set', { chatId, agentIds })   // index becomes position
  → handler: every agent must exist, then one transaction; emit chat.updated
  → store: membersByChat[chatId] = the returned order
  → ChatRunner picks the new list up on its next run
```

### Changing a group setting

```
a select / the segmented control changes
  → useChatsStore.updateSettings(chatId, { speaking: 'parallel' })
  → invoke('chats.update', { id, patch: { settings: { speaking: 'parallel' } } })
  → handler validates the field, repository merges it into the stored object
  → store applies the returned chat; the header badge re-renders from it
```

### Opening a chat

```
click a row
  → chats.select(id)
  → ChatsPage effect: messages.load(id) unless that chat is already loaded
  → invoke('messages.list', { chatId, limit: 100 })   // newest first
  → store reverses into oldest-first and renders
```

### A streaming reply (the path that matters)

```
Enter in the composer
  → useRunStore.send(chatId, text)
  → invoke('chat.send')            → ChatRunner (see ../orchestration/)
  ← message.created (user)         → messages store appends it
  ← run.started / run.round        → run store shows Stop
  ← message.created (agent, empty, streaming)
  ← message.delta × N              → append to the last part of that kind
  ← message.updated                → replace wholesale; status, usage, error
  ← run.finished                   → run store clears; the button goes back to Send
```

Deltas are increments and are applied by `applyDeltaToParts`; `message.updated`
is authoritative, so a dropped delta is cosmetic and the transcript still
converges.

### Deleting a chat

```
kebab → Delete → Delete again
  → invoke('chats.delete', { id })
  → handler: ctx.runners.remove(id)   // abort first: the rows are about to go
             chats.delete(id)         // cascades to members and messages
             emit chat.deleted
  → stores: drop the chat, its transcript, its presences and its run state
```

## Key types and contracts

`Chat`, `ChatMember`, `Message`, `MessagePart`, `MessageStatus` and `Usage` are
unchanged from S1.1. S2.2 added two input types next to them —
**`ChatCreateInput`** (a `ChatPatch` plus `memberAgentIds`) and **`ChatPatch`**
(every field optional, `settings` a partial that the backend merges) — plus the
`MIN_AUTO_ROUNDS` / `MAX_AUTO_ROUNDS` bounds both layers validate against.

| Channel / method | Request | Response | Notes |
|---|---|---|---|
| `chats.list` | — | `Chat[]` | Newest `updatedAt` first |
| `chats.get` | `{ id }` | `Chat` | `not_found` for an unknown id |
| `chats.create` | `{ input: ChatCreateInput }` | `Chat` | `memberAgentIds` seeds the members; without it the chat is empty unless the agent library is |
| `chats.update` | `{ id, patch: ChatPatch }` | `Chat` | Rename and a **partial** `settings` merge; always bumps `updatedAt` |
| `chats.delete` | `{ id }` | `void` | Stops the run first; cascades |
| `chats.members.list` | `{ chatId }` | `ChatMember[]` | **New in S1.7.** Ordered by `position` |
| `chats.members.set` | `{ chatId, agentIds }` | `ChatMember[]` | Replaces the list; array index becomes `position` |
| `messages.list` | `{ chatId, before?, limit? }` | `Message[]` | Newest first; `before` is a message id |
| `chat.send` | `{ chatId, text, mentions? }` | `Message` | The stored user message; output arrives as events. `validation('chat has no members')` before anything is written |
| `chat.stop` | `{ chatId }` | `void` | Idempotent |

| Event | Payload | Emitted when |
|---|---|---|
| `chat.updated` | `{ chat }` | A chat is created, renamed or has its members replaced |
| `chat.deleted` | `{ chatId }` | A chat is deleted |
| `message.created` | `{ message }` | A message row is inserted (user or agent) |
| `message.delta` | `{ chatId, messageId, delta }` | One increment of a streaming message |
| `message.updated` | `{ message }` | A message reaches its final state |

The `run.*` and `presence.changed` events are emitted by `orchestration` and
`agent-turn`; this feature only reduces them.

## Tests

| File | Covers |
|---|---|
| `src/main/orchestration/chat-runner.test.ts` (`describe('chats handlers')`) | `chats.create` default title and settings; the `validation` refusal with no usable provider; rename bumping `updatedAt` and emitting `chat.updated`; the empty-title rejection; `messages.list` order and the `before` cursor; delete stopping the run and emitting `chat.deleted`. Also: the runner re-reads the members on the next run, and `chat.send` on an empty chat stores nothing |
| `src/main/handlers/chats.test.ts` | Who a new chat starts with (bootstrap / empty / explicit order), `members.set` validation and its event, and every `ChatSettings` bound |
| `src/main/handlers/handlers.test.ts` | Every declared method has a handler; the ones still stubbed reject with `internal` |
| `src/renderer/src/stores/chats.test.ts` | `groupChats` (all three buckets, empty groups omitted, the 23:50 case, a future timestamp, order inside a group); load, create, rename guard; `chat.updated` upsert and re-sort; `chat.deleted` clearing the selection |
| `src/renderer/src/stores/messages.test.ts` | `applyDeltaToParts` (append, kind switch, first part, whole part, no mutation); created / delta / updated reduction; ignored deltas; page reversal; failed load as state |
| `src/renderer/src/lib/reorder.test.ts` | The drag's index arithmetic in both directions, the no-op and the out-of-range cases |
| `e2e/chat.spec.ts` | The whole feature against a real local model: create, send, stream, stop, second chat, restart |
| `e2e/members.spec.ts` | Offline: an empty chat refusing a send, adding both agents, dragging one above the other and surviving a restart, removing one, persisting the group settings and the header badge, and a deleted agent leaving the chat |

## Known limitations and TODOs

- **`stallTimeoutMs` / `hardTimeoutMs` are read by `AgentSupervisor`**
  ([`presence`](../presence/implement.md)), merged over `AppSettings.timeouts` at
  every heartbeat. Only the hard budget has a control in the group settings block;
  the stall override is honoured by the backend but has no UI of its own.
- **Reordering is mouse-only**, and the per-member token count is an em dash
  until S4.1.
- **The search field is disabled** (S4.3), and titles are always the default
  `New chat` until the user renames one.
- **The message list is not virtualized** and loads one page of 100 with no
  upward paging; both are S2.5.
- **`chats.members.list` is one call per chat** on load. See the trade-off table
  in `context.md`.
