# orchestration — Backend

> S1.7 built the minimal runner; **S2.3 owns this feature**. See
> "What S2.3 adds" in [`context.md`](./context.md).

## Modules

| File | Responsibility |
|---|---|
| `src/main/orchestration/chat-runner.ts` | `ChatRunner` (one per chat) and `ChatRunnerRegistry` (the map on `AppContext`) |
| `src/main/app-context.ts` | Creates the registry and stops every runner in `close()` |
| `src/main/handlers/chats.ts` | `chat.send` / `chat.stop` delegate to the registry; `chats.delete` calls `remove` first |

Neither class imports electron: a runner reaches the world only through
`ctx.repos`, `ctx.events` and the injected `createModel` (CLAUDE.md rule #5).

## Database

No table of its own, and no migration. It writes exactly one row per user
message:

| Table | Column | Value |
|---|---|---|
| `messages` | `sender_type` / `sender_id` | `user` / `ctx.userId` |
| | `parts` | one `text` part, trimmed |
| | `status` | `done` — a user message is complete the moment it is stored |
| | `round` | `0`; rounds are 1-based and belong to the agents |
| | `mentions` | whatever the caller passed, stored but not yet acted on |

It reads `chat_members` (ordered by `position`) and `agents` to resolve the
speakers, and `chats` to confirm the chat exists before writing anything.

## IPC handlers

None of its own; it is called by two of [`chats`](../chats/backend.md)'s:

| Channel | Reaches |
|---|---|
| `chat.send` | `ctx.runners.send({ chatId, text, mentions })` |
| `chat.stop` | `ctx.runners.stop(chatId)` |
| `chats.delete` | `ctx.runners.remove(chatId)` **before** the rows are deleted |

## Events emitted

| Event | Payload | Emitted when |
|---|---|---|
| `message.created` | `{ message }` | The user's message is stored — before the run is scheduled, and also when it is only queued |
| `run.started` | `{ chatId, round }` | A run begins. Not emitted for a chat with no members |
| `run.round` | `{ chatId, round, speakers }` | A round begins |
| `run.finished` | `{ chatId, reason }` | `completed` \| `stopped` \| `error`. `max-rounds` arrives with S2.3 |

The `message.delta`, `message.updated` and `presence.changed` events inside a run
come from [`agent-turn`](../agent-turn/backend.md).

## Concurrency

This is the part worth reading twice, because it is where a subtle bug would hide.

- **One `AbortController` per run**, created in `#runOnce` and dropped in its
  `finally`. `stop()` aborts the current one and clears the queue; aborting a
  finished run is a no-op.
- **`#running` is the whole loop's promise**, not one turn's. `whenIdle()` awaits
  it — the tests' "wait for the reply" — and `#start()` attaches a `catch` so a
  failure inside the loop can never become an unhandled rejection in the main
  process.
- **The run is deliberately not awaited by the handler.** `chat.send` resolves as
  soon as the message is stored and the run is scheduled, which is what the
  `BackendApi` contract promises; awaiting it would block the IPC call for the
  length of a model response.
- **SQLite has one writer**, and every write here is synchronous through
  `better-sqlite3`, so two concurrent runs in different chats cannot interleave a
  partial write. `messages.seq` is assigned inside the insert transaction for the
  same reason (see [`../database/backend.md`](../database/backend.md)).
- **Deleting a chat mid-run** aborts first and only then deletes, because the
  cascade removes the very rows the turn is writing into.
- The MVP needs no message broker for any of this: all concurrency lives in one
  process, the barrier is `Promise.all`, and the bus is in-process (PLAN,
  "Reserved server capability"). A server version replaces `EventBus` and
  `MessageRepository`, not `ChatRunner`.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `ai` (v7) | Only indirectly, through `runAgentTurn` | The runner never touches `streamText`; it passes a signal and reads `{ status, aborted }`. That is what keeps "who speaks" and "how a model streams" separable |
| `ai/test` `MockLanguageModelV4` | The integration tests, injected as `createModel` | A mock that resolves instantly makes ordering assertions meaningless — the cancellation tests pace their streams with `simulateReadableStream({ chunkDelayInMs })` so the abort lands mid-answer |
