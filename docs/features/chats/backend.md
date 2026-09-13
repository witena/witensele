# chats — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/main/handlers/chats.ts` | The nine `chats.*` / `messages.list` / `chat.*` methods: validation, the bootstrap member on create, stopping the run on delete, and the `chat.*` events |
| `src/main/handlers/agents.ts` | `agents.list` only, landed early because the chat screen renders author names and model badges. S2.1 adds the other four |
| `src/main/agents/default-agent.ts` | `ensureDefaultAgent(ctx)`: one "Assistant" bound to the first provider that has a model |
| `src/main/db/repositories/chats.ts` | Unchanged from S1.2; `list` ordered by `updatedAt`, `setMembers` in one transaction |
| `src/main/db/repositories/messages.ts` | Unchanged from S1.2; `seq` ordering, the `before` cursor, `listForContext` for the runner |
| `src/main/testing.ts` | `createTestAppContext`: a context over the temporary database, the recording bus and the insecure secret store. Not imported by production code |

None of them imports electron (CLAUDE.md rule #5).

## Database

No migration: S1.2 created every table this step uses.

| Table | Column | Type | Notes |
|---|---|---|---|
| `chats` | `id`, `user_id` | text | UUID primary key, scoped by user |
| | `title` | text | `New chat` until renamed; S4.3 generates one |
| | `workdir` | text null | Reserved for the executor agent; always `null` |
| | `settings` | json | `ChatSettings`; written only by the defaults so far, S2.2 gives it a form |
| | `created_at` / `updated_at` | integer | Epoch ms. `updated_at` is bumped by every message insert, which is what floats an active chat to the top |
| `chat_members` | `chat_id`, `agent_id`, `position` | text / text / integer | Composite key; `ON DELETE CASCADE` from both parents |
| `messages` | `seq` | integer | Per-chat monotonic, assigned inside the insert transaction. The transcript's total order, and the `before` cursor's |
| | `sender_type` / `sender_id` | text | `user` + `ctx.userId`, or `agent` + the agent id |
| | `parts` | json | `MessagePart[]`; rewritten by the flush during streaming |
| | `status` | text enum | `streaming` → `done` \| `passed` \| `error` |
| | `round` | integer | 0 for a user message, 1-based for an agent's |
| | `usage` | json null | Written once at the end of a turn |
| | `error` | text null | `'aborted'` after Stop, otherwise the provider's message |

## IPC handlers

| Channel | Input | Output | Errors |
|---|---|---|---|
| `chats.list` | — | `Chat[]` newest first | — |
| `chats.get` | `{ id }` | `Chat` | `validation` on an empty id, `not_found` otherwise |
| `chats.create` | `{ input: Partial<ChatInput> }` | `Chat` | `validation` for an empty title, a non-object `settings` or `maxAutoRounds < 1`; `validation` **"no provider with models"** when no provider can back the bootstrap agent |
| `chats.update` | `{ id, patch }` | `Chat` | Same patch checks; `not_found` |
| `chats.delete` | `{ id }` | `void` | `not_found`. Stops the run **before** deleting |
| `chats.members.list` | `{ chatId }` | `ChatMember[]` by `position` | `validation`, `not_found` |
| `chats.members.set` | `{ chatId, agentIds }` | `ChatMember[]` | `validation` for a non-array or a duplicate agent; `not_found` for an unknown agent |
| `messages.list` | `{ chatId, before?, limit? }` | `Message[]` newest first | `validation` on an empty chat id or a non-positive limit; `not_found` for an unknown cursor |
| `chat.send` | `{ chatId, text, mentions? }` | `Message` | `validation` for a non-string or blank text; `not_found` for an unknown chat — checked **before** anything is written |
| `chat.stop` | `{ chatId }` | `void` | `validation` on an empty id; otherwise idempotent |

## Events emitted

| Event | Payload | Emitted when |
|---|---|---|
| `chat.updated` | `{ chat }` | `chats.create`, `chats.update`, `chats.members.set` |
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

**S2.1 turns this into user-managed agents.** When the agents page lands, agents
are created by the user, `chats.create` takes an explicit member list, and this
function survives only as the empty-library fallback. Nothing else may assume
there is exactly one agent.
