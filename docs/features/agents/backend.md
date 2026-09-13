# agents — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/main/handlers/agents.ts` | The five handlers, all the validation, and the deletion choreography |
| `src/main/db/repositories/agents.ts` | Straight CRUD over the `agents` table (S1.2) |
| `src/main/db/repositories/chats.ts` | `listChatIdsForAgent`, added in S2.1 so deletion and rename know which chats to announce |
| `src/main/agents/default-agent.ts` | `ensureDefaultAgent`, now reached only while the agents table is empty |

Nothing here imports electron (CLAUDE.md rule #5): the handlers take an
`AppContext` and reach the world through `ctx.repos`, `ctx.events` and
`ctx.runners`.

## Table

`agents` — `id`, `user_id`, `name`, `avatar` (json `AgentAvatar`), `description`,
`system_prompt`, `provider_id`, `model_id`, `params` (json `AgentParams`),
`skill_names` (json), `mcp_server_ids` (json), `memory_enabled`, `role`,
`created_at`, `updated_at`.

No migration was needed for S2.1. `InitialAvatar.textColor` is a new **optional**
field inside a column that is already JSON, so old rows deserialize unchanged and
render on the neutral fallback foreground.

`chat_members.agent_id` references `agents.id` with `ON DELETE CASCADE`, which is
what makes `agents.delete` remove memberships. That requires
`PRAGMA foreign_keys = ON`, which `openDatabase` sets.

## Handlers

| Method | Behaviour |
|---|---|
| `agents.list` | Every agent of the user, oldest first |
| `agents.get` | One agent; `not_found` for an unknown id |
| `agents.create` | Validates the whole input, trims the name, inserts |
| `agents.update` | `not_found` first, then validates only the fields the patch carries; emits `chat.updated` for every chat the agent is in |
| `agents.delete` | Stops the run of every chat the agent is in, deletes the row, then emits `chat.updated` for those chats |

### Validation

Shared between create and update (`assertName` takes the record's own id so an
agent may keep its name):

- `name`: non-empty after trimming; no `@`; unique per user, case-insensitive.
  Spaces are allowed — "Architect copy" must be a legal duplicate, and S2.3
  resolves the longest matching member name rather than splitting on whitespace.
- `providerId`: a string, and `repos.providers.get` must find it (`not_found`).
- `modelId`: non-empty after trimming.
- `params.temperature`: finite and within `[0, 2]`; `params.maxTokens`: a positive
  integer. Absent means "the provider's default" and is always valid.
- `role`: `participant` or `executor`. **Both are written by the UI from S5.2**;
  the role decides whether `collectAgentTools` attaches a `sideEffects` MCP
  server (S3.1), and whether S5.3 attaches the executor's own tools.
- `memoryEnabled`: a boolean. From S3.3 it is what `agent-turn` reads to decide
  whether to attach `memory_save` / `memory_search` and inject the `MEMORY.md`
  index; turning it off leaves every file in place.
- `skillNames` / `mcpServerIds`: arrays of strings. `skillNames` is written by
  the agent form from S3.2 and holds skill **names**, which is why nothing
  cascades when a skill folder is deleted — see
  [`../skills/backend.md`](../skills/backend.md). `mcpServerIds` is written from
  S3.1, and
  `mcp.delete` removes a deleted server's id from every agent through
  `repos.agents.removeMcpServer` — the column is JSON, not a foreign key, so
  nothing cascades on its own.

### Why deletion stops runs first

`chat_members` cascades silently. A chat that was mid-run with the deleted agent
would keep streaming a turn for somebody who is no longer a member, writing
message rows and emitting events for a membership the renderer has already been
told changed. `ctx.runners.stop(chatId)` is idempotent, so stopping every affected
chat — running or not — costs nothing and makes the outcome the same every time.
The `chat.updated` events are emitted **after** the delete, so the payload is the
post-delete state.

## Events

| Event | When |
|---|---|
| `chat.updated` | Once per chat containing the agent, on `agents.update` and on `agents.delete` |

There is deliberately **no** `agent.created` / `agent.updated` event: the Agents
page is the only writer and patches its own list, and every other screen renders
agents *through* a chat, which `chat.updated` already covers.

## Pitfalls

- `ctx.repos.agents.list()` is read on every name check. That is an O(n) scan per
  write on a table with a handful of rows; a `UNIQUE` index would need a
  case-folding collation and would report the clash as a driver error rather than
  as a `validation` the renderer can translate.
- `listChatIdsForAgent` joins `chat_members` to `chats` so it can filter by
  `chats.user_id`; the membership table carries no `user_id` of its own.
- `ensureDefaultAgent` still throws `validation('no provider with models')` when
  the provider list is empty. That is now reachable only on a first run, because
  after S2.2 a chat is created without members unless the library is empty.
- **"One executor per chat" is not checked here.** The rule is a property of a
  chat's membership and lives in `chats.members.set` / `chats.create`
  (`assertOneExecutor`, see [`../chats/backend.md`](../chats/backend.md)). The
  consequence is a known gap: `agents.update` will happily promote a
  `participant` that is already in a chat with an executor, which reaches the
  forbidden state by another door. S5.3 must therefore pick a chat's executor
  deterministically — the first `executor` in `position` order — rather than
  assuming the set has exactly one.
