# chats — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/main/handlers/chats.ts` | The nine `chats.*` / `messages.list` / `chat.*` methods: validation (including every `ChatSettings` field), the member list a chat is born with, stopping the run on delete, and the `chat.*` events |
| `src/main/handlers/agents.ts` | The five `agents.*` methods; see [`agents`](../agents/backend.md) |
| `src/main/agents/default-agent.ts` | `ensureDefaultAgent(ctx)`: one "Assistant" bound to the first provider that has a model, reached only while the agents table is empty |
| `src/main/db/repositories/chats.ts` | `list` ordered by `updatedAt`, `setMembers` in one transaction, and `listChatIdsForAgent` (added in S2.1) |
| `src/main/db/repositories/messages.ts` | Unchanged from S1.2; `seq` ordering, the `before` cursor, `listForContext` for the runner |
| `src/main/testing.ts` | `createTestAppContext`: a context over the temporary database, the recording bus and the insecure secret store. Not imported by production code |

None of them imports electron (CLAUDE.md rule #5).

## Database

S1.2 created every table this feature uses. S2.3 added one column to `messages`:
`in_reply_to` (migration `0001_spooky_odin.sql`), the agent ids — plus the
literal `user` — whose messages asked for that reply. It is nullable, so every
row written before it stores nothing at all, and the UI's "replying to @x" label
is the only thing that reads it. See
[`../database/backend.md`](../database/backend.md).

| Table | Column | Type | Notes |
|---|---|---|---|
| `chats` | `id`, `user_id` | text | UUID primary key, scoped by user |
| | `title` | text | `New chat` until renamed; S4.3 generates one |
| | `workdir` | text null | Reserved for the executor agent; always `null` |
| | `settings` | json | `ChatSettings`; written by the member panel's group-settings block, merged field by field |
| | `created_at` / `updated_at` | integer | Epoch ms. `updated_at` is bumped by every message insert, which is what floats an active chat to the top |
| `chat_members` | `chat_id`, `agent_id`, `position` | text / text / integer | Composite key; `ON DELETE CASCADE` from both parents |
| `messages` | `seq` | integer | Per-chat monotonic, assigned inside the insert transaction. The transcript's total order, and the `before` cursor's |
| | `sender_type` / `sender_id` | text | `user` + `ctx.userId`, or `agent` + the agent id |
| | `parts` | json | `MessagePart[]`; rewritten by the flush during streaming |
| | `status` | text enum | `streaming` → `done` \| `passed` \| `error` |
| | `round` | integer | 0 for a user message, 1-based for an agent's, counted **within a run** |
| | `mentions` | json | Agent ids this message @mentioned. On a user message, the effective set (parsed ∪ explicit, ∩ members); on a reply, what the model wrote |
| | `in_reply_to` | json null | Agent ids (plus `user`) whose messages asked for this reply |
| | `usage` | json null | Written once at the end of a turn |
| | `error` | text null | `'aborted'` after Stop, otherwise the provider's message |

## IPC handlers

| Channel | Input | Output | Errors |
|---|---|---|---|
| `chats.list` | — | `Chat[]` newest first | — |
| `chats.get` | `{ id }` | `Chat` | `validation` on an empty id, `not_found` otherwise |
| `chats.create` | `{ input: ChatCreateInput }` | `Chat` | The patch checks below; `not_found` for a `memberAgentIds` entry that names no agent; `validation` **"no provider with models"** only on the bootstrap path |
| `chats.update` | `{ id, patch: ChatPatch }` | `Chat` | The patch checks below; `not_found` |
| `chats.delete` | `{ id }` | `void` | `not_found`. Stops the run **before** deleting |
| `chats.members.list` | `{ chatId }` | `ChatMember[]` by `position` | `validation`, `not_found` |
| `chats.members.set` | `{ chatId, agentIds }` | `ChatMember[]` | `validation` for a non-array or a duplicate agent; `not_found` for an unknown agent, checked before anything is written. An **empty** array is valid: it is how the last member is removed |
| `messages.list` | `{ chatId, before?, limit? }` | `Message[]` newest first | `validation` on an empty chat id or a non-positive limit; `not_found` for an unknown cursor |
| `chat.send` | `{ chatId, text, mentions? }` | `Message` | `validation` for a non-string or blank text and for **`chat has no members`**; `not_found` for an unknown chat — all checked **before** anything is written |
| `chat.stop` | `{ chatId }` | `void` | `validation` on an empty id; otherwise idempotent |

### Chat patch validation

`assertChatPatch` checks only the fields a patch carries. `settings` is a partial
that the repository merges into the stored object, so a single control can be
persisted on its own:

| Field | Rule |
|---|---|
| `title` | Non-empty after trimming |
| `settings.mode` | `roundrobin` or `mention-only` |
| `settings.speaking` | `sequential` or `parallel` |
| `settings.maxAutoRounds` | An integer in `[MIN_AUTO_ROUNDS, MAX_AUTO_ROUNDS]` = `[1, 10]` |
| `settings.stallTimeoutMs` / `hardTimeoutMs` | A finite number greater than zero |

### Who a new chat starts with

`chats.create` seeds members in exactly two ways:

1. `memberAgentIds` is given — those agents, in that order.
2. It is not — the chat is created **empty**, *unless* the agents table is also
   empty, in which case `ensureDefaultAgent` writes the bootstrap agent and puts
   it in. That is the only reason a fresh install can hold a conversation before
   anyone opens the Agents page.

A chat with no members refuses `chat.send` with `validation('chat has no
members')`, checked in `ChatRunner.send` before the user's message is persisted.
The composer stays enabled (the fix is one click away in the member panel) and
the panel shows `chat.noMembersHint`.

## Events emitted

| Event | Payload | Emitted when |
|---|---|---|
| `chat.updated` | `{ chat }` | `chats.create`, `chats.update`, `chats.members.set`, and — from [`agents`](../agents/backend.md) — `agents.update` / `agents.delete`, once per affected chat |
| `chat.deleted` | `{ chatId }` | `chats.delete`, after the rows are gone |
| `message.created` | `{ message }` | The user's message, from `ChatRunner.send` |

`message.delta`, `message.updated`, `run.*` and `presence.changed` are emitted by
[`agent-turn`](../agent-turn/backend.md) and
[`orchestration`](../orchestration/backend.md).

## Filesystem

Nothing. Chats and messages live entirely in `userData/witena.db`.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `drizzle-orm` / `better-sqlite3` | Every read and write, through the S1.2 repositories | Deleting a chat cascades to `chat_members` and `messages`, which needs `PRAGMA foreign_keys = ON` — `openDatabase` sets it. A run still streaming into a deleted chat would write to rows that no longer exist, which is why `chats.delete` aborts first |
| `react-markdown` 10 + `remark-gfm` 4 | The message body (renderer) | Partial markdown is the normal case mid-stream — an unclosed fence, half a table. react-markdown renders what it can rather than throwing, so no guard is needed. Both were already dependencies; no typography plugin is used, the prose rules are descendant utilities in `markdown.tsx` |

### The bootstrap agent

`ensureDefaultAgent(ctx)` returns the first existing agent, or creates one when
the table is empty:

| Field | Value |
|---|---|
| `name` | `Assistant` |
| `avatar` | `{ kind: 'initial', text: 'A', color: '#4a3a2f' }` — the mockup's warm monogram tile |
| `description` | `General assistant` (the group briefing prints it) |
| `systemPrompt` | One sentence; the briefing already carries the protocol |
| `providerId` / `modelId` | The first provider with `models.length > 0`, and its `models[0]` |
| `role` | `participant` |

It throws `validation('no provider with models')` otherwise — a state the user
can fix in Settings → Providers, which is why it is a rejection the renderer can
translate rather than a silently empty chat.

**Since S2.1 it is only the empty-library fallback.** Agents are created by the
user on the Agents page and `chats.create` takes an explicit `memberAgentIds`.
`ensureDefaultAgent` fires only while `agents` has no rows at all, so the very
first chat of a fresh install still answers. Nothing may assume there is exactly
one agent.
