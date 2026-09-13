# orchestration — Context

> **Status: partial.** S1.7 built the smallest `ChatRunner` that is still the
> real shape — one agent, one round, one abortable run. **S2.3 is the step that
> owns this feature**; the section "What S2.3 adds" below is the list of what is
> deliberately missing, and it is the first thing to read before touching
> `chat-runner.ts`.

## Problem

A chat is not a request/response API. A user message starts a *run*: one or more
rounds, each with one or more speakers, each speaker taking a turn, the whole
chain interruptible at any moment, and the transcript the single source of truth
throughout. `ChatRunner` is the thing that decides **who speaks and when**, and
that owns the `AbortController` the Stop button reaches.

## Scope (S1.7)

- One `ChatRunner` per chat, held by `ChatRunnerRegistry` on the `AppContext`.
- `send`: persist the user message, emit `message.created`, then either start a
  run or queue one.
- One run = one round = the chat's first member, taking one `AgentTurn`.
- `run.started` / `run.round` / `run.finished` with a reason.
- `stop`: abort the active run and drop the queue.
- The queue: a message sent during a run is answered by the next run.

## What S2.3 adds

Everything below is already shaped for — the signatures exist, the events exist,
and the tests assert the current behaviour — so S2.3 *extends* this file rather
than rewriting it:

| Missing | Where it goes |
|---|---|
| **Round scheduling.** A run is currently one round; S2.3 loops rounds until nothing schedules another or `maxAutoRounds` is hit, then finishes with `max-rounds` | `#runOnce` becomes a round loop |
| **`@mention` parsing.** An agent's reply is scanned for `@name`, deduplicated, self excluded; the result is stored in `Message.mentions` and becomes the next round's speakers | A new parser module, called at the end of a turn |
| **Speaker selection.** `roundrobin` gives every member in `position` order; `mention-only` gives only the mentioned ones | `#speakersFor(round, members)`, which today returns `members.slice(0, 1)` |
| **Parallel speaking.** `ChatSettings.speaking === 'parallel'` runs the round's turns with `Promise.all` | The sequential `for` loop in `#runOnce` |
| **The round barrier.** A round ends only when every speaker is `done`, `passed`, `skipped` or `error`; no agent enters the next round while another is still answering | The same place; sequential satisfies it naturally, parallel needs the explicit wait |
| **`[PASS]` in scheduling.** The status already exists; S2.3 uses it to decide whether a round produced anything worth continuing for | The round loop |
| **System notices.** "Reached the limit of N automatic rounds", "the run was stopped" — the keys already exist under `notices.*` | Emitted as `system` messages at the round boundary |

S2.4 then adds the supervisor that can mark a speaker `skipped` mid-round, which
the barrier must treat as complete.

## Out of scope (permanently, for this feature)

| Not here | Owned by |
|---|---|
| What one agent does during its turn | [`agent-turn`](../agent-turn/context.md) |
| Persisting chats and messages, and the chat UI | [`chats`](../chats/context.md) |
| Heartbeat, timeouts, presence transitions | `presence` (S2.4) |
| Tool execution | `mcp` (S3.1) |

## Dependencies

| Feature | What this one needs from it |
|---|---|
| [`agent-turn`](../agent-turn/context.md) | `runAgentTurn`, and its promise that it never throws and always leaves a terminal status |
| [`database`](../database/context.md) | `ChatRepository.listMembers`, `AgentRepository.get`, `MessageRepository.create` |
| [`chats`](../chats/context.md) | The handlers that call it, and the renderer that reduces its events |

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| **A message sent during a run is stored immediately and taken into account from the next round boundary** — with one agent, the next run | Abort the current turn and restart with the new message; refuse the send; hold the text in memory until the run ends | Aborting throws away a half-generated answer the user already paid for, and with several agents it would abort the ones that had nothing to do with the interruption. Refusing loses what the user typed. Holding it in memory loses it to a crash. Storing it now also means the next run needs no special handling: every turn rebuilds its view from the whole transcript, so "queued" only ever means "a run is owed" |
| One `AbortController` **per run**, on the runner | One per turn; one global | Stop has to interrupt the whole chain, and a run outlives the IPC call that started it — `chat.stop` must reach the same controller `chat.send` created |
| The registry lives on `AppContext` | A module singleton | Two contexts (a test's and the app's) must never share runners, and the context is already the injection point for everything else |
| A run with no members emits **nothing** | Emit `run.started` + `run.finished { error }` | A chat the user has emptied is not an error; emitting a run would make the composer wait for a reply that was never scheduled |
| The queue holds **message ids**, and one run answers all of them | One run per queued message | The next turn reads the whole transcript anyway, so N queued messages need one run, not N |
| `#speakersFor` exists even though it returns one member | Inline `members[0]` | It is the seam S2.3 replaces, and naming it is what makes the extension obvious |

## Open questions

- Whether `run.finished { reason: 'error' }` should also emit a `system` notice
  message, or whether the errored agent message is enough. S2.3 decides, together
  with the multi-speaker case where one agent fails and others succeed.
- Whether a queued message should cancel a *pending* round in a multi-round run
  rather than waiting for the whole run to finish. The decision above only fixes
  the behaviour up to the next round boundary.
