# chats — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/main/handlers/chats.ts` | The `chats.*` / `messages.*` / `chat.*` methods: validation (including every `ChatSettings` field, and since S5.2 `workdir` against the real filesystem and the one-executor rule), the member list a chat is born with, stopping the run on delete, the `chat.*` events, plus `chats.search` and `messages.usageSummary` (S4.1, S4.3) |
| `src/shared/pricing.ts` | The model price table, `estimateCost`, `contextWindowFor` and the `formatTokens` / `formatCost` helpers. Shared, because the renderer prices the same numbers; see [`providers`](../providers/backend.md) for how to edit the table |
| `src/shared/usage.ts` | `summarizeUsage`: the one copy of the per-chat / per-agent arithmetic, run by this handler over the database and by `stores/usage.ts` over the transcript in the store |
| `src/main/handlers/agents.ts` | The five `agents.*` methods; see [`agents`](../agents/backend.md) |
| `src/main/agents/default-agent.ts` | `ensureDefaultAgent(ctx)`: one "Assistant" bound to the first provider that has a model, reached only while the agents table is empty |
| `src/main/db/repositories/chats.ts` | `list` ordered by `updatedAt`, `setMembers` in one transaction, and `listChatIdsForAgent` (added in S2.1) |
| `src/main/db/repositories/messages.ts` | Unchanged from S1.2; `seq` ordering, the `before` cursor, `listForContext` for the runner |
| `src/main/testing.ts` | `createTestAppContext`: a context over the temporary database, the recording bus and the insecure secret store. Not imported by production code |

None of them imports electron (CLAUDE.md rule #5). `handlers/chats.ts` does read
`node:fs` and `node:path` since S5.2, which the rule permits: it is about
electron, not about Node, and the `workdir` check is worthless if it does not
touch the filesystem.

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
| | `title` | text | `New chat` until it is renamed, or until `ChatRunner` generates one after the first run (S4.3) |
| | `workdir` | text null | Absolute path of the folder this chat's executor works in, or `null`. Written by `chats.update`, which validates it; real since S5.2 |
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
| `chats.create` | `{ input: ChatCreateInput }` | `Chat` | The patch checks below; `not_found` for a `memberAgentIds` entry that names no agent; `validation` + `second_executor` for two executors, checked **before** the row is written; `validation` **"no provider with models"** only on the bootstrap path |
| `chats.update` | `{ id, patch: ChatPatch }` | `Chat` | The patch checks below; `not_found` |
| `chats.delete` | `{ id }` | `void` | `not_found`. Stops the run **before** deleting |
| `chats.members.list` | `{ chatId }` | `ChatMember[]` by `position` | `validation`, `not_found` |
| `chats.members.set` | `{ chatId, agentIds }` | `ChatMember[]` | `validation` for a non-array or a duplicate agent, and `validation` + `second_executor` for two `executor` agents in the resulting list; `not_found` for an unknown agent. All of it before anything is written. An **empty** array is valid: it is how the last member is removed |
| `chats.search` | `{ query }` | `string[]` chat ids, newest first, capped at `CHAT_SEARCH_LIMIT` (200) | `validation` when `query` is not a string. A blank query is **not** an error: it means "no filter" and returns every chat |
| `messages.list` | `{ chatId, before?, limit? }` | `Message[]` newest first | `validation` on an empty chat id or a non-positive limit; `not_found` for an unknown cursor |
| `messages.usageSummary` | `{ chatId }` | `ChatUsageSummary` over the whole transcript | `validation` on an empty id, `not_found` for an unknown chat |
| `chat.send` | `{ chatId, text, mentions? }` | `Message` | `validation` for a non-string or blank text and for **`chat has no members`**; `not_found` for an unknown chat — all checked **before** anything is written |
| `chat.stop` | `{ chatId }` | `void` | `validation` on an empty id; otherwise idempotent |

### Chat patch validation

`assertChatPatch` checks only the fields a patch carries. `settings` is a partial
that the repository merges into the stored object, so a single control can be
persisted on its own:

| Field | Rule |
|---|---|
| `title` | Non-empty after trimming |
| `workdir` | `null`, or an absolute path that `statSync` reports as a directory. Three distinct `ValidationReason`s: `workdir_not_absolute`, `workdir_missing`, `workdir_not_directory` |
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

### The working directory (S5.2)

`ChatPatch.workdir` is `string | null`, and `assertWorkdir` checks it against the
**real filesystem** rather than merely parsing it: absolute, `statSync`
succeeds, and the result `isDirectory()`. The path is a security boundary and
not a label — every file the executor resolves in S5.4 is resolved inside it,
and a folder that does not exist cannot confine anything.

`statSync` follows symlinks on purpose. A symlink to a directory is a perfectly
good working directory; the confinement check that matters (a path *inside* the
folder whose realpath leaves it) is per file and belongs to S5.4.

There is a race that cannot be closed here: the folder can be deleted between
this check and the first tool call. That is what makes it a check and not a
guarantee, and why S5.4 resolves every path again at the moment of use.

The same rules run on `chats.create`, because `assertChatPatch` is shared — a
chat cannot be born pointing at a path a later update would refuse.

`ChatRunner` already re-reads the chat record every round (`repos.chats.get`), so
`workdir` reaches the orchestrator with no new plumbing; nothing reads it yet,
because attaching executor tools is S5.4.

### One executor per chat (S5.2)

PLAN.md: *discussion agents are read-only; all writes go through one executor*.
Several models writing into the same directory overwrite each other and leave a
diff nobody can review, so `assertOneExecutor` refuses a member list holding two
`executor` agents, with `validation` and the reason `second_executor`.

It lives where membership is **written** rather than where tools are attached,
because `chats.members.set` replaces the whole list and is therefore the only
place that can see the resulting set. Swapping one executor for another in a
single call is consequently fine: that list holds one.

**Known gap:** `agents.update` can promote a `participant` that is already in a
chat with an executor, which reaches the same forbidden state by another door.
The refusal was scoped to the member handler by S5.2; S5.4 must therefore pick a
chat's executor deterministically (first `executor` in `position` order) rather
than assuming the set has exactly one.

### Searching chats (S4.3)

`chats.search` delegates to `ChatRepository.search`, which is two stages on
purpose:

1. **SQL narrows.** One `LIKE` over `chats.title` and one over `messages.parts`.
   `parts` is a JSON column, so SQL can only match the serialized blob — which is
   fast and deliberately *over*-matches: the word `text` appears in every part's
   own `type` field, and a tool name or a notice key would hit too.
2. **JavaScript decides.** Every row the blob scan returned is parsed and only
   its `text` parts are checked, case-insensitively. The blob scan is what keeps
   this half from having to deserialize every message in the database.

`escapeLike` escapes `%`, `_` and the backslash itself, and the query is issued
with `ESCAPE '\\'`. Without it, searching for `50%` would match every chat and
`a_b` would match `axb` — silently, and looking like a broken search rather than
like a query that meant something else. Results are re-read through `chats`
ordered by `updated_at` so they arrive in the same order as `chats.list`, which
is what lets the left column keep its Today / Yesterday / Earlier grouping while
a filter is on.

### Usage and cost (S4.1)

`messages.usageSummary` runs `summarizeUsage` (`src/shared/usage.ts`) over
`listForContext`, supplying a lookup from agent id to `{ modelId, presetId }`
built from the agents and providers repositories and memoized per call. An agent
or provider the user has since deleted resolves to `undefined`: its tokens stay
in the total and its cost is reported as unknown, which is the honest answer.

Only messages that carry a `usage` object count — the provider reports it once,
at the end of a turn — and every terminal status counts, `error` included: a turn
the user stopped halfway still billed for what it had generated.

The **renderer does not call this per turn.** It reads it once when a chat is
opened, because the summary covers the whole transcript while the messages store
holds a page of it, and recomputes the same function locally on every
`message.updated`. Both sides therefore run identical arithmetic and cannot
drift.

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
| `shiki` 4 (renderer) | Syntax highlighting inside a fenced code block | The default entry bundles every grammar and theme, and the default regex engine is Oniguruma compiled to WebAssembly — a `.wasm` asset fetched by a renderer loaded from `file://`. `lib/highlighter.ts` therefore uses `shiki/core` with `createJavaScriptRegexEngine()` and imports one grammar per language on demand (`shiki/langs/<name>.mjs`); the specifiers are static so the bundler can split them. The returned HTML has every source character escaped, which is what makes `dangerouslySetInnerHTML` safe here |
| `react-virtuoso` 4 (renderer) | Virtualizing the transcript | It renders a **flat** list, so day separators have to be rows rather than wrappers. A row that grows while it streams is remeasured when it re-enters the viewport, which is why `increaseViewportBy` is generous |
| `electron` `setWindowOpenHandler` (main) | Links in a message body | Markdown links carry `target="_blank"`, which in Electron opens a second `BrowserWindow` with full renderer privileges. `src/main/index.ts` denies **every** such request and hands only `http:` / `https:` to `shell.openExternal` first. The scheme check is the security half: a model can write any URL into a reply, and opening a `file:` or a custom scheme would hand whatever the OS registered for it a path a language model chose |

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
