# orchestration — Backend

> Implemented in S2.3. The round loop itself is in
> [`implement.md`](./implement.md); this file is the module, table, event and
> dependency inventory.

## Modules

| File | Responsibility |
|---|---|
| `src/shared/mentions.ts` | `parseMentions` / `findMentions` / `splitMentions`: the `@Name` rule, shared with the renderer so the composer and the scheduler can never disagree |
| `src/main/orchestration/scheduling.ts` | `planFromUserMessages`, `planFromReplies`, `planFromHandoff`, `planFromReview`, `mergePlans`, `reachedRoundLimit` — the pure "who speaks next" |
| `src/main/orchestration/chat-runner.ts` | `ChatRunner` (one per chat: the round loop, the `AbortController`, the pending list, `RunState`, and from S4.2 / S4.3 / S5.11 the `contextTruncated` and `materialsTruncated` notices and the automatic title) and `ChatRunnerRegistry` (the map on `AppContext`) |
| `src/main/agents/title.ts` | `generateChatTitle` and its two pure halves, injected into the runner as `ChatRunnerOptions.generateTitle` so a test can replace it |
| `src/main/app-context.ts` | Creates the registry and stops every runner in `close()` |
| `src/main/handlers/chats.ts` | `chat.send` / `chat.stop` / `chat.handoff` delegate to the registry; `chats.delete` calls `remove` first |

Neither class imports electron: a runner reaches the world only through
`ctx.repos`, `ctx.events` and the injected `createModel` (CLAUDE.md rule #5).
`scheduling.ts` and `mentions.ts` reach nothing at all.

## Database

No table of its own. The migration S2.3 *does* need belongs to the message row it
writes: `0001_spooky_odin.sql` adds `messages.in_reply_to`
(see [`../database/backend.md`](../database/backend.md)).

One row per user message:

| Table | Column | Value |
|---|---|---|
| `messages` | `sender_type` / `sender_id` | `user` / `ctx.userId` |
| | `parts` | one `text` part, trimmed |
| | `status` | `done` — a user message is complete the moment it is stored |
| | `round` | `0`; rounds are 1-based and belong to the agents |
| | `mentions` | the **effective** set: parsed from the text, unioned with the composer's explicit ids, intersected with the chat's members |

…and one row per hand-off (S5.6), which is a **user** message too:

| Column | Value |
|---|---|
| `sender_type` / `sender_id` | `user` / `ctx.userId` — the click is the user speaking |
| `parts` | one `system-notice` part: `handoff { agent }`, the executor's name |
| `status` / `round` | `done` / `0` |
| `mentions` | the executor's id, alone |

…and one row per system notice:

| Column | Value |
|---|---|
| `sender_type` / `sender_id` | `system` / `system` |
| `parts` | one `system-notice` part: `noMentions`, `maxRoundsReached { max }` or `runFailed { message }` |
| `status` / `round` | `done` / the round the run was in when it stopped |

It reads `chat_members` (ordered by `position`) and `agents` to resolve the
speakers, `chats` for the settings, and `messages.listForContext` for the
parallel snapshot — all **once per round**, so a membership or settings change
lands at the next round boundary rather than mid-turn.

## IPC handlers

None of its own; it is called by two of [`chats`](../chats/backend.md)'s:

| Channel | Reaches |
|---|---|
| `chat.send` | `ctx.runners.send({ chatId, text, mentions })` |
| `chat.handoff` | `ctx.runners.handoff({ chatId })` — the handler only checks that a `chatId` is a string; the folder, the executor and "is a run going" are facts about the run, and the runner is the only object that holds all three. It rejects with `validation` plus one of `handoff_no_workdir` / `handoff_no_executor` / `handoff_run_active` in `details` |
| `chat.stop` | `ctx.runners.stop(chatId)` |
| `chats.delete` | `ctx.runners.remove(chatId)` **before** the rows are deleted |

## Events emitted

| Event | Payload | Emitted when |
|---|---|---|
| `message.created` | `{ message }` | The user's message is stored — before the run is scheduled, and also when it only joins a running one. Also every `system-notice` row |
| `run.started` | `{ chatId, round: 1 }` | Once per run, before the first round. Not emitted for a chat with no members |
| `run.round` | `{ chatId, round, speakers }` | Each round begins |
| `run.finished` | `{ chatId, reason }` | Once per run: `completed` \| `stopped` \| `max-rounds` \| `error` |

`chat.updated` is also emitted once per run when the automatic title lands; the
`chats` feature owns the field and the list row that redraws.

The `message.delta`, `message.updated` and `presence.changed` events inside a run
come from [`agent-turn`](../agent-turn/backend.md). The runner wraps each turn's
`onEvent` to record that turn's `messageId` in `RunState.activeTurns` and then
forwards the event unchanged — the order the renderer sees is the order the turn
produced.

## Concurrency

This is the part worth reading twice, because it is where a subtle bug would hide.

- **One `AbortController` per run**, created in `#loop` and dropped in `#start`'s
  `finally`. It is handed to *every* turn of *every* round, so Stop reaches the
  siblings of a parallel round too. `stop()` aborts it and clears the pending
  list; aborting a finished run is a no-op.
- **`#running` is the whole loop's promise**, not one turn's. `whenIdle()` awaits
  it — the tests' "wait for the reply" — and `#start()` attaches a `catch` so a
  failure inside the loop can never become an unhandled rejection in the main
  process.
- **The pending list is drained inside the loop**, and `#start`'s `finally`
  restarts the loop if something landed in the sliver between the loop's last
  check and the moment `#running` became `null`. Without that, a message sent in
  exactly that window would sit in the list forever: `send` saw a run in flight,
  and the loop had already decided it was done.
- **The barrier is `Promise.allSettled`**, not `all`: a rejection must not leave
  a sibling streaming into a run that has been declared over. `runAgentTurn`
  never throws, so a rejected entry means a bug, and it is logged and counted as
  an errored outcome rather than swallowed.
- **The run is deliberately not awaited by the handler.** `chat.send` resolves as
  soon as the message is stored and the run is scheduled, which is what the
  `BackendApi` contract promises; awaiting it would block the IPC call for the
  length of a whole multi-round discussion.
- **SQLite has one writer**, and every write here is synchronous through
  `better-sqlite3`, so the concurrent turns of a parallel round cannot interleave
  a partial write. `messages.seq` is assigned inside the insert transaction for
  the same reason, which is what keeps a parallel round's transcript order
  stable (see [`../database/backend.md`](../database/backend.md)).
- **Deleting a chat mid-run** aborts first and only then deletes, because the
  cascade removes the very rows the turns are writing into.
- The MVP needs no message broker for any of this: all concurrency lives in one
  process, the barrier is a promise, and the bus is in-process (PLAN, "Reserved
  server capability"). A server version replaces `EventBus` and
  `MessageRepository`, not `ChatRunner`.

## The hand-off, round by round (S5.6, S5.12)

`handoff()` validates, stores the message, sets `#handoff` — `{ agentId, intent }`
— and starts the loop. `#loop` **takes** that field once, before the first
iteration, and then spends it over two rounds:

| Iteration | Plan | `implementing` | `reviewing` |
|---|---|---|---|
| 1 | `mergePlans(memberIds, planFromHandoff(memberIds, executorId), carried)` | the executor | `false` |
| 2 | `mergePlans(memberIds, planFromReview(memberIds, executorId), carried)` | `null` | `true` |
| 3+ | Ordinary `planFromReplies`, so a reviewer's `@Hands` schedules another executor round | `null` | `false` |

Four details that are decisions:

- **Taken, not read.** `#start`'s `finally` restarts the loop when a message
  landed in the sliver where the run was ending; a field still holding the
  executor id would hand the same chat over twice.
- **Merged, not assigned.** A user message that arrived while the executor was
  working is still answered — by the review round, alongside it.
- **`implementing` is one agent for one round**, and it is the only thing that
  sets `AgentTurnOptions.handoff`. A reviewer told to "implement the conclusion"
  would be the wrong instruction, and so would an executor re-`@`-ed later.
- **`reviewing` is the whole round** (S5.12), and it is the only thing that sets
  `AgentTurnOptions.reviewing`. Every speaker of round 2 is reading what the
  executor changed; round 3 is ordinary `@` scheduling and carries neither flag,
  which is asserted by the *absence* of both blocks in the second executor
  prompt.

`intent` (S5.12) travels beside the executor id and reaches exactly two places:
the notice key stored on the user message (`handoff` or `handoffDeliver`), and
`AgentTurnOptions.handoff` for the one implementing turn. Nothing about the
scheduling reads it.

Everything else — Stop, the barrier, the cap, the offline filter, the truncation
notice — applies unchanged, which is the reason the hand-off is two staged plans
rather than a mode of its own.

### The four refusals, in order

| Order | Reason | True when |
|---|---|---|
| 1 | `handoff_no_workdir` | the chat is bound to no folder |
| 2 | `handoff_no_executor` | no member has `role: 'executor'` |
| 3 | `handoff_no_deliverable` | `intent: 'deliver'` and the goal is not a `document` naming a file |
| 4 | `handoff_run_active` | a run of this chat is already going |

The transient one is **last** deliberately: a chat that is both missing its
deliverable and running should be told about the deliverable, which is the rule
that will still be true in a minute. `components/chat/handoff.ts` computes the
same four from the same facts in the same order, so the disabled button and the
rejection cannot name different rules.

## Three things the runner announces, and why it is the runner (S4.2, S4.3, S5.11)

Both are facts about a **run**, and `AgentTurn` does not know one is happening.

### `contextTruncated`

`runAgentTurn` runs its history through `fitHistory`
([`../agent-turn/implement.md`](../agent-turn/implement.md)) and reports
`droppedMessages` in its result. `#noticeTruncation` turns a non-zero count into
one `system-notice` with `{ agent, dropped }` — **once per run per agent**, held
in a `Set` that `#loop` clears when a run starts.

### `materialsTruncated`

`buildTurnPrompt` assembles the goal's materials inside a quarter of the model's
context window and reports `materialsOmitted`
([`../agent-turn/implement.md`](../agent-turn/implement.md)).
`#noticeMaterials` turns the first non-zero count of a round into one
`system-notice` with `{ agent, omitted }` — **once per chat**, which is the whole
difference from the notice above. The dedupe is a boolean field that `#loop` does
**not** clear, backed by a scan of the transcript for an existing notice with
that key, so a relaunched app does not repeat the sentence either. Only the first
agent that had to trim is named: members can have different context windows and
therefore different budgets, and naming each of them would be one complaint
written four ways.

Per round would bury the discussion under the same sentence, because a chat long
enough to overflow overflows again on every round for the rest of its life. Per
chat would be the other extreme: a user who comes back the next day and asks
something else deserves to be told again that the agent cannot see the beginning
any more.

### The automatic title

`#maybeTitle` runs after the loop and **before** `run.finished`, so a renderer
that reloads on that event already has the new title. It does nothing unless all
of these hold:

1. The chat's title is still exactly `DEFAULT_CHAT_TITLE`. That comparison is the
   whole mechanism — there is no "was this generated" flag to keep in sync, and no
   way for the feature to overwrite something a human typed.
2. The transcript holds a user message **and** an agent message with status
   `done`. A run that errored, was stopped, or in which everyone passed has
   nothing worth naming.

It then builds the **first member's** model through the same injected
`createModel` the turns use and calls `generateTitle` (default
`generateChatTitle`): one `generateText` with `maxOutputTokens: 24`, a 15 second
budget, chained to the run's own signal so Stop abandons it too. Every failure is
swallowed — a title is a convenience — and the fallback is the first 40
characters of the user's question, so the chat always ends up with something
better than `New chat`. The result is sanitised (`sanitizeTitle`), persisted
through `ChatRepository.update` and broadcast as `chat.updated`.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `ai` (v7) | Only indirectly, through `runAgentTurn` | The runner never touches `streamText`; it passes a signal and reads `{ status, aborted, message.mentions }`. That is what keeps "who speaks" and "how a model streams" separable |
| `ai/test` `MockLanguageModelV4` | The integration tests, injected as `createModel` | A mock that resolves instantly makes ordering assertions meaningless — the cancellation tests pace their streams with `simulateReadableStream({ chunkDelayInMs })` so the abort lands mid-answer. The multi-agent tests give **each agent its own mock**, because `doStreamCalls` is how "the second speaker saw the first one's reply" is asserted |
| Real Ollama models | `e2e/orchestration.spec.ts` | A real reply may legitimately contain `@Reviewer` and schedule another round, so the spec never asserts "exactly N messages for the rest of the run": it counts deltas, waits for the run to end, and caps `maxAutoRounds` where an exact count matters |
