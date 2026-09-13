# orchestration — Implementation

> S1.7 built the minimal runner; **S2.3 owns this feature**. See
> "What S2.3 adds" in [`context.md`](./context.md) before changing anything here.

## Approach

Two classes in `src/main/orchestration/chat-runner.ts`:

- **`ChatRunner`** — one per chat. Holds the active `AbortController`, the
  `RunState`, and the queue of user messages that arrived mid-run.
- **`ChatRunnerRegistry`** — a `Map<chatId, ChatRunner>` on the `AppContext`,
  created by `createAppContext` and stopped by `close()`.

A runner is stateful because a run outlives the IPC call that started it: `send`
resolves as soon as the message is stored and the run is *scheduled*, and the
agent's output arrives later as events. `chat.stop` must therefore find the same
controller, and the queue must survive between calls.

The split that makes S2.3 an extension rather than a rewrite:

| Method | Today | S2.3 |
|---|---|---|
| `#loop` | run once, then again if the queue is non-empty | unchanged |
| `#runOnce` | one round, sequential speakers | a round loop with a barrier and `maxAutoRounds` |
| `#speakersFor(round, members)` | `members.slice(0, 1)` | roundrobin / mention-only |
| `#members(chat)` | membership in `position` order | unchanged |

## Data flow

### A message that starts a run

```
chat.send
  → ChatRunner.send({ chatId, text, mentions })
      chats.get(chatId)                         // not_found before anything is written
      messages.create({ senderType: 'user', senderId: ctx.userId, round: 0 })
      emit message.created
      no run active → #start()
  ← resolves with the stored message

#loop → #runOnce
      members = listMembers → agents.get
      members.length === 0 → return, emitting nothing
      speakers = #speakersFor(1, members)
      emit run.started { round: 1 }
      emit run.round   { round: 1, speakers }
      for each speaker: await runAgentTurn(...)      // see ../agent-turn/
      emit run.finished { reason }
```

### A message that arrives during a run

```
chat.send
  → messages.create + emit message.created      // immediately, as always
  → a run is active → push the id onto the queue
  ← resolves

… the current run finishes, emits run.finished …

#loop sees a non-empty queue
  → clear it, then #runOnce again
  → the new turn's history already contains both questions
```

The queue is cleared **before** the next run rather than after, so a message that
lands during *that* run queues another one.

### Stop

```
chat.stop → registry.stop(chatId) → runner.stop()
  queue = []
  controller.abort()
    → the in-flight streamText unwinds
    → runAgentTurn returns { aborted: true }, having persisted status 'error' / 'aborted'
  → run.finished { reason: 'stopped' }
```

### Finish reasons

| Reason | When |
|---|---|
| `completed` | Every speaker finished (`done` or `passed`) |
| `stopped` | The signal was aborted — Stop, or `chats.delete` |
| `error` | A turn ended in `error` without an abort, or the loop itself threw |
| `max-rounds` | **Not emitted yet.** S2.3 emits it when `maxAutoRounds` is reached |

## Key types and contracts

```ts
interface RunState { chatId: string; round: number; speakers: string[]; startedAt: number }

class ChatRunner {
  get state(): RunState | null
  get isRunning(): boolean
  send(input: { chatId, text, mentions? }): Promise<Message>
  stop(): void
  whenIdle(): Promise<void>          // the test seam for "wait for the reply"
}

class ChatRunnerRegistry {
  for(chatId): ChatRunner
  send(input): Promise<Message>
  stop(chatId): void
  remove(chatId): void               // stop and forget; used by chats.delete
  state(chatId): RunState | null
  stopAll(): void                    // called by AppContext.close()
}
```

`ChatRunnerOptions.createModel` is the injection point: `createAppContext` passes
it through, and the tests hand in a `MockLanguageModelV4` so no provider is ever
built.

| Event | Payload | Emitted when |
|---|---|---|
| `message.created` | `{ message }` | The user's message is stored, before the run is scheduled |
| `run.started` | `{ chatId, round }` | A run begins |
| `run.round` | `{ chatId, round, speakers }` | A round begins, with its speakers in order |
| `run.finished` | `{ chatId, reason }` | The run ends and control returns to the user |

## Tests

| File | Covers |
|---|---|
| `src/main/orchestration/chat-runner.test.ts` | The full event sequence of one send → stream → persist cycle, in order; the single member as the round's speaker; `RunState` while running and `null` afterwards; `[PASS]` → `passed` with `completed`; Stop → `stopped` plus `error` / `'aborted'` on the message; stopping an idle chat as a no-op; a provider failure → `error`; a queued second message running as a second run whose prompt contains both questions; the queue being dropped on Stop; the two validation rejections. Plus the `chats handlers` block: create, rename, `messages.list` paging, and delete stopping a live run |
| `e2e/chat.spec.ts` | The same behaviours against a real local model, including Stop interrupting an actual HTTP stream |

## Known limitations and TODOs

Everything in "What S2.3 adds" in [`context.md`](./context.md), plus:

- **A failed turn does not retry**, and there is no "retry this agent" action.
  PLAN mentions one for offline agents; it belongs with S2.4.
- **`run.finished { reason: 'error' }` carries no detail.** The errored message
  holds it; the event is a signal, not a report.
- **`whenIdle()` exists for the tests.** It is not part of the IPC surface, and a
  handler must not await it — `chat.send` promises to resolve as soon as the run
  is scheduled.
