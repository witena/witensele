# chats — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/main/handlers/chats.ts` | The `chats.*` / `messages.*` / `chat.*` methods: validation (including every `ChatSettings` field, since S5.2 `workdir` against the real filesystem and the one-executor rule, and since S5.10 the whole goal table), the member list a chat is born with, stopping the run on delete, the `chat.*` events, plus `chats.search`, `messages.usageSummary` (S4.1, S4.3) and `chats.goalStatus` (S5.10) |
| `src/main/executor/paths.ts` | `resolveInWorkdir`, reused by this handler since S5.10 so a goal can never name a file the executor itself would be refused. See [`executor`](../executor/backend.md) |
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
| | `goal` | json null | `ChatGoal` (S5.10), or `null`. Migration `0003_acoustic_vermin.sql`; **replaced** by `chats.update`, never merged |
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
| `chats.goalStatus` | `{ chatId }` | `ChatGoalStatus` | `validation` on an empty id, `not_found` for an unknown chat. A chat with no `document` goal answers `{ deliverable: null, delivered: false }` rather than rejecting — the header asks for every chat it draws |
| `messages.list` | `{ chatId, before?, limit? }` | `Message[]` newest first | `validation` on an empty chat id or a non-positive limit; `not_found` for an unknown cursor |
| `messages.usageSummary` | `{ chatId }` | `ChatUsageSummary` over the whole transcript | `validation` on an empty id, `not_found` for an unknown chat |
| `chat.send` | `{ chatId, text, mentions? }` | `Message` | `validation` for a non-string or blank text and for **`chat has no members`**; `not_found` for an unknown chat — all checked **before** anything is written |
| `chat.handoff` | `{ chatId }` | `Message` (the stored hand-off row) | `validation` on an empty id; `not_found` for an unknown chat; `validation` plus one of `handoff_no_workdir` / `handoff_no_executor` / `handoff_run_active` in `details`. The handler checks only the id: the other three are facts about the **run**, and [`orchestration`](../orchestration/backend.md)'s `ChatRunner.handoff` is the only object that holds all of them |
| `chat.stop` | `{ chatId }` | `void` | `validation` on an empty id; otherwise idempotent |

### Chat patch validation

`assertChatPatch` checks only the fields a patch carries. `settings` is a partial
that the repository merges into the stored object, so a single control can be
persisted on its own:

| Field | Rule |
|---|---|
| `title` | Non-empty after trimming |
| `workdir` | `null`, or an absolute path that `statSync` reports as a directory. Three distinct `ValidationReason`s: `workdir_not_absolute`, `workdir_missing`, `workdir_not_directory` |
| `goal` | `null`, or the table in "The chat goal" below. Validated against the **effective** folder: the patch's own `workdir` when it carries one, otherwise the stored one |
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

### The chat goal (S5.10)

`ChatPatch.goal` is `ChatGoal | null`, and `assertGoal` checks it against the
folder the goal will live in — which is the **patch's own** `workdir` when the
call binds one and the stored one otherwise, so binding a folder and setting a
goal in a single `chats.update` is legal. The stored row is read lazily, through
a thunk, so a patch with no goal still costs one write and no read.

| Rule | Refusal |
|---|---|
| `description` non-empty after trimming | `goal_description_empty` |
| `description` at most `MAX_GOAL_DESCRIPTION_CHARS` (2 000) | `goal_description_too_long` |
| `kind: 'document'` carries a `deliverable` | `goal_deliverable_required` |
| A `deliverable` is relative, non-empty and free of `..` | `goal_deliverable_not_relative` |
| A `deliverable` resolves inside `workdir` (`resolveInWorkdir`, symlinks included) | `goal_deliverable_outside_workdir` |
| Every `material` is relative, non-empty and free of `..` | `goal_material_not_relative` |
| Every `material` resolves inside `workdir` | `goal_material_outside_workdir` |
| Every `material` **exists** | `goal_material_missing` |
| `document` / `codebase`, or any material, requires a `workdir` | `goal_needs_workdir` |
| A `deliverable` on a kind that is not `document` | plain `validation`, **no reason** |
| A malformed object: unknown `kind`, `materials` that is not an array of strings | plain `validation`, no reason |

The last two rows are the line this table draws deliberately. A
`ValidationReason` is a **sentence the user is meant to act on**, so it exists
for every refusal a control can produce and for none of the ones only a
hand-written call can: the panel drops the deliverable when the kind changes,
and no control can send `kind: 'anything'`.

Two asymmetries worth keeping:

- **A deliverable is not checked for existence, a material is.** The whole point
  of a deliverable is that it is not there yet, and its parent folder need not
  exist either; a material is something the group reads, so a missing one is a
  goal that cannot be met.
- **Absolute and `..` share a reason**, because they share a fix: write the path
  relative to the folder. "Outside the folder" is a different mistake with a
  different fix, and it is discovered by a different check —
  `resolveInWorkdir`, which follows symlinks, which is why a goal can never name
  a file the executor would be refused at the moment of use.

Since S5.11 the material check earns its keep twice over: a path that exists and
resolves inside the folder is exactly a path `agents/materials.ts` can read and
`read_file` can fetch, so the validation at save time and the reader at turn time
apply the same rule through the same function (`resolveInWorkdir`). The reader
still re-resolves and re-stats every path — a material can be deleted between the
two moments, and one that has been is dropped from the prompt silently rather
than named as something the group cannot open.

A goal stores **relative** paths for the reason the workdir is absolute: the
folder is a machine-local binding, while the goal describes the project and
survives it being moved, cloned or restored from a backup. Converting the
absolute paths the native dialogs return is the renderer's job, and so is
refusing one that fell outside the folder — no dialog on any platform this runs
on can be confined to a directory (see [frontend.md](./frontend.md)).

`chats.goalStatus` is separate from all of this because it asks the filesystem
rather than validating a request: `deliverablePath(goal, workdir)` plus
`existsSync`. That helper lives in `executor/paths.ts` and is shared, since
S5.12, with the executor turn that appends the deliverable's `FileRefPart`, so
the chip in the header and the chip in the transcript cannot come to name two
different files. It uses `join` rather than `resolveInWorkdir` on purpose — the
path was confined when the goal was saved, and a folder that has since gone
should answer "not delivered" to a chip that only wants to know whether to say
so, not throw.

### Handing a chat to its executor (S5.6, S5.12)

`chat.handoff` is a few lines in this module and the rest is
[`orchestration`](../orchestration/backend.md)'s, which is the same division
`chat.send` follows: this feature owns the chat record and its columns, and the
runner owns what a run does with them. The one thing this module checks is the
**shape** of S5.12's `intent` — it is either absent or one of `HANDOFF_INTENTS` —
because "is this a well-formed request" is the handler layer's question, while
"can this chat satisfy it" needs the chat, its members and whether a run is
going, which only the runner holds. The four refusals are
`ValidationReason`s for S5.2's reason — the seven `BackendErrorCode`s are a
failure taxonomy, and "the request was rejected as invalid" cannot tell a user
whether to pick a folder or to add a member.

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
[`orchestration`](../orchestration/backend.md); `permission.requested` /
`permission.resolved`, which the S5.5 card is drawn from and dismissed by, come
from [`executor`](../executor/backend.md)'s gate. This feature's backend half is
unchanged by S5.5: the permission card, the diff block and the file-reference
chip are renderer-only, and the `DiffPart`s they draw are appended by the turn.

S5.7 leaves it unchanged too, with one read: `system.openInEditor` looks a chat
up by id and takes its `workdir` as the folder a path must resolve inside. It
writes nothing, emits nothing, and treats a chat that has been deleted as simply
no confinement; the method belongs to [`editor`](../editor/backend.md).

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
