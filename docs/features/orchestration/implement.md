# orchestration — Implementation

> Implemented in S2.3. Read [`context.md`](./context.md) first: it holds the
> decisions this file only executes.

## Approach

Three modules:

| File | Shape |
|---|---|
| `src/shared/mentions.ts` | Pure. `parseMentions(text, members) → agentId[]`, plus `findMentions` and `splitMentions` for the renderer. Shared with the composer so both sides resolve `@Name` identically |
| `src/main/orchestration/scheduling.ts` | Pure. Member ids + already-parsed mentions → a `RoundPlan`. No database, no events, no clock. Since S5.6 also `planFromHandoff` (the executor alone) and `planFromReview` (everybody else) |
| `src/main/orchestration/chat-runner.ts` | Stateful. `ChatRunner` (one per chat) and `ChatRunnerRegistry` (the map on `AppContext`) |

A runner is stateful because a run outlives the IPC call that started it: `send`
resolves as soon as the message is stored and the run is *scheduled*, and the
agent's output arrives later as events. `chat.stop` must therefore find the same
controller, and the pending list must survive between calls.

## The state machine

```
                    ┌───────── send() / handoff() while idle ──────────┐
                    ▼                                                   │
  idle ──────► run.started ──► [round loop] ──► run.finished ──► idle ──┘
                                   ▲   │
                 send() while running   │ pending user messages, or mentions
                    (appended to    └───┘ from the round that just ended
                     #pending)
```

One iteration of the round loop:

```ts
chat    = chats.get(chatId)                       // settings, every round
members = listMembers(chat).map(agents.get)       // position order, every round
if (members.length === 0) break                   // emptied chat: not an error
if (!started) emit run.started { round: 1 }
if (signal.aborted) { reason = 'stopped'; break }

pending = takePending()                           // Message[] stored by send()
plan    = pending.length > 0
  ? (roundsSinceUser = 0,
     mergePlans(memberIds, planFromUserMessages(chat.settings.mode, memberIds, pending), carried))
  : carried
carried = EMPTY_PLAN

// S5.6: the two rounds a hand-off owns, one per iteration, merged with
// whatever else was scheduled rather than replacing it.
implementing = null
if (handoffTo !== null && handoffStage !== 'done') {
  if (handoffStage === 'executor') {
    implementing = handoffTo
    plan = mergePlans(memberIds, planFromHandoff(memberIds, handoffTo), plan)
    handoffStage = 'review'
  } else {
    plan = mergePlans(memberIds, planFromReview(memberIds, handoffTo), plan)
    handoffStage = 'done'
  }
}

if (plan.speakers.length === 0) {                 // nothing to schedule
  if (pending.length > 0) notice('noMentions')    // mention-only, nobody named
  break                                           // → completed
}
if (roundsSinceUser >= chat.settings.maxAutoRounds) {
  notice('maxRoundsReached', { max })
  reason = 'max-rounds'; break
}

round += 1; roundsSinceUser += 1
emit run.round { round, speakers: plan.speakers }
outcomes = await runRound(...)                    // the barrier; see below

if (aborted)                        { reason = 'stopped'; break }
if (outcomes.every(o => error))     { reason = 'error';   break }
carried = planFromReplies(memberIds, outcomes)    // self / non-members / passed dropped
```

and then, once, outside the loop: `emit run.finished { reason }`.

### The barrier

```ts
sequential: for (const speaker of speakers) { await turn(speaker); if (aborted) break }
parallel:   const snapshot = messages.listForContext(chatId)     // once, before
            await Promise.allSettled(speakers.map(turn))         // ← the barrier
```

`runAgentTurn` takes the snapshot as its optional `history`; without it a turn
reads the transcript itself, which is exactly what makes the second sequential
speaker see the first one's reply. `Promise.allSettled` rather than `all`: one
rejection must not leave a sibling unawaited, streaming into a run that has
already been declared over. `runAgentTurn` promises never to throw, so a rejected
entry is recorded as an errored outcome and logged.

### Scheduling rules

| Input | Speakers |
|---|---|
| User message(s), `roundrobin` | every member, `position` order |
| User message(s), `mention-only` | the mentioned members, `position` order |
| The round that just ended | every member mentioned by its replies, minus self-mentions, minus non-members, minus `passed` repliers |
| `handoff()`, first round | the chat's executor, alone, `inReplyTo: ['user']` — the chat's `mode` is not consulted |
| `handoff()`, second round | every other member, in `position` order, `inReplyTo: [executorId]` |

Each plan also carries `inReplyTo`: speaker id → who pulled them in (agent ids,
or the literal `'user'`). It is passed to `runAgentTurn` and stored on the
message, which is what the UI's "replying to @x" reads.

## Data flow

### A message that starts a run

```
chat.send
  → ChatRunner.send({ chatId, text, mentions })
      chats.get(chatId)                          // not_found before anything is written
      members = listMembers → agents.get         // empty → validation('chat has no members')
      mentions = parseMentions(text, members) ∪ (explicit ∩ members)
      messages.create({ senderType: 'user', round: 0, mentions })
      emit message.created
      push onto #pending; no run active → #start()
  ← resolves with the stored message
```

### A message that arrives during a run

```
chat.send
  → messages.create + emit message.created       // immediately, as always
  → push onto #pending                           // the run is already going
  ← resolves

… the current round finishes …

the loop takes the pending list
  → roundsSinceUser = 0                          // the cap starts counting again
  → speakers = (mode plan for those messages) ∪ (mentions of the round that ended)
  → the next turn's history already contains every question
```

The list is taken **before** the round runs, so a message that lands during that
round schedules the round after it.

### A hand-off (S5.6)

```
chat.handoff
  → ChatRunner.handoff({ chatId })
      chats.get(chatId)                          // not_found before anything is written
      chat.workdir  ?? throw validation('handoff_no_workdir')
      executor = first member with role 'executor'
                ?? throw validation('handoff_no_executor')
      #running !== null → throw validation('handoff_run_active')
      messages.create({ senderType: 'user', parts: [handoff notice], mentions: [executor.id] })
      emit message.created
      #handoffTo = executor.id; #start()
  ← resolves with the stored message

… the loop …
  round 1: [executor]              (handoff: true on that turn's briefing)
  round 2: [every other member]    (reviewing, fed by the executor's message)
  round 3+: ordinary @ scheduling, capped by maxAutoRounds
```

The three refusals are `ValidationReason`s rather than bare `validation`s, and
the renderer computes the **same three** from the chat record to decide whether
to enable the button (`components/chat/handoff.ts`), in the same order, so the
tooltip and the rejection can never name different rules.

### Stop

```
chat.stop → registry.stop(chatId) → runner.stop()
  #pending = []
  controller.abort()
    → every in-flight streamText unwinds, in every speaker of a parallel round
    → runAgentTurn returns { aborted: true }, having persisted 'error' / 'aborted'
  → run.finished { reason: 'stopped' }
```

### Finish reasons

| Reason | When |
|---|---|
| `completed` | No round scheduled another one — including `mention-only` with nothing mentioned, which also writes the `noMentions` notice |
| `max-rounds` | `roundsSinceUser` reached `chat.settings.maxAutoRounds` while a round was still scheduled; writes `maxRoundsReached` |
| `stopped` | The signal was aborted — Stop, `chats.delete`, or `AppContext.close()` |
| `error` | Every speaker of a round errored, or the loop itself threw (which also writes `runFailed`) |

## Key types and contracts

```ts
interface ActiveTurn { agentId: string; messageId: string; startedAt: number }

interface RunState {
  chatId: string
  round: number                    // 1-based, monotonic within the run
  speakers: string[]               // the current round, in order
  activeTurns: ActiveTurn[]        // not yet terminal
  pendingUserMessageIds: string[]  // stored, not yet scheduled
  startedAt: number
}

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
  getState(chatId): RunState | null  // the live round, its speakers and turns
  state(chatId): RunState | null     // alias kept from S1.7
  stopAll(): void                    // called by AppContext.close()
}
```

`ChatRunnerOptions.createModel` is the injection point: `createAppContext` passes
it through, and the tests hand in a `MockLanguageModelV4` so no provider is ever
built.

| Event | Payload | Emitted when |
|---|---|---|
| `message.created` | `{ message }` | The user's message, and every system notice |
| `run.started` | `{ chatId, round: 1 }` | Once per run, before the first round |
| `run.round` | `{ chatId, round, speakers }` | Each round, with its speakers in order |
| `run.finished` | `{ chatId, reason }` | Once per run |

`message.delta`, `message.updated` and `presence.changed` come from
[`agent-turn`](../agent-turn/backend.md); the runner forwards them through a
wrapper that only reads the `message.created` of each turn to learn its
`messageId`.

## Tests

| File | Covers |
|---|---|
| `src/shared/mentions.test.ts` | ASCII names, names with spaces, CJK names, longest match (`Ann` vs `Ann Lee`), case-insensitivity, the `@Anna` boundary, `@all` / `@everyone`, a member named "all", an `@` inside an address, dedupe and order, and `splitMentions` for the renderer |
| `src/main/orchestration/scheduling.test.ts` | Both modes' round 1, mentions → speakers, self-mention, non-member, `[PASS]`, merged sources, position order, the plan union and the round-limit predicate including the reset |
| `src/main/orchestration/chat-runner.test.ts` | The S1.7 single-agent sequence, plus: every member in round 1; sequential sees the previous reply and parallel does not; a mention scheduling round 2 with only that member and the `inReplyTo` it stores; a self-mention scheduling nothing; `[PASS]`; the `maxAutoRounds` cap and its notice; `mention-only` with and without a mention; explicit composer mentions; a mid-run message joining the next round and resetting the counter; Stop aborting both turns of a parallel round; one failing speaker not blocking the other; every speaker failing → `error`; one `run.started` and one `run.finished` per multi-round run |
| `src/main/agents/agent-turn.test.ts` | The stored `mentions`, no mentions on a `[PASS]`, `inReplyTo` stored and absent, and the prebuilt `history` snapshot being used instead of the live transcript |
| `src/renderer/src/stores/run.test.ts` | The composer's resolved mentions reaching `chat.send`, and an empty list being omitted |
| `src/main/orchestration/chat-runner.test.ts` (`describe('ChatRunner (usage, truncation and titles)')`) | S4.1–S4.3 through the handlers: `messages.usageSummary` summing per agent and pricing a known model, an empty summary and `not_found`; the `contextTruncated` notice appearing once per run with the agent and the count, and not appearing when the history fits; a title generated from a mock model's `doGenerate`, sanitised, falling back when the generator returns `null` or throws, never replacing a title the user set or set later, and never written when every turn failed; a trailing `[PASS]` leaving the status `done` while disappearing from the next speaker's prompt; and `chats.search` finding a chat by a word in one of its messages |
| `e2e/polish.spec.ts` | Against a real local model: the header and member-row token counts, the automatic title replacing `New chat`, and the search box filtering the left column |
| `src/main/orchestration/chat-runner.test.ts` (`describe('ChatRunner (hand to executor)')`) | S5.6, nine cases: the stored message (a `user` row carrying the `handoff` key and mentioning only the executor), the executor speaking alone in a `roundrobin` chat followed by one review round with the other two in `position` order and their `inReplyTo`, the extended briefing in the handed-over turn's prompt and the executor's answer in the reviewers' prompts, no review round when the executor is the only member, a reviewer's `@` scheduling another executor round whose prompt no longer carries the hand-off briefing until `maxAutoRounds` takes the floor back, a Stop inside the executor's tool call leaving `permissions.pending()` empty and nothing on disk, and the three refusals |
| `src/main/orchestration/scheduling.test.ts` (S5.6 block) | `planFromHandoff` and `planFromReview`, including an executor that has left the chat and an executor that is the only member |
| `src/renderer/src/components/chat/handoff.test.ts` | `handoffBlocker`: the enabled case, the three refusals, a blank `workdir`, and the order the rules are applied in |
| `src/renderer/src/stores/run.test.ts` (S5.6 block) | `handoff` calling `chat.handoff` with nothing but the id, and a refusal keeping its `details` so the composer can name the reason |
| `e2e/orchestration.spec.ts` | Two real models: round-robin in round 1, parallel streaming both rows at once, `mention-only` answering with one member, and the `noMentions` notice |
| `e2e/executor.spec.ts` | Offline: the hand-off button's `data-blocked` naming the rule that disabled it, and the backend refusing on the same rule. Behind the `qwen2.5:3b` guard: two participants plus an executor discuss, "Hand to executor" is clicked, the permission prompt is allowed, a file appears in the folder and a participant speaks again |

## Known limitations and TODOs

- A round that loses every speaker to `isOffline` finishes `completed` with the
  `allOffline` notice. It is not `error`: nothing failed, there was simply nobody
  left to ask.
- **A failed turn does not retry**, and there is no "retry this agent" action.
- **`run.finished { reason: 'error' }` carries no detail.** The errored message
  holds it; the event is a signal, not a report.
- **`whenIdle()` exists for the tests.** It is not part of the IPC surface, and a
  handler must not await it — `chat.send` promises to resolve as soon as the run
  is scheduled.
- **The title is generated once and never revisited.** A chat that started with a
  throwaway question and turned into something else keeps the first title until
  the user renames it. Re-titling a chat under the user's feet would be worse.
- **The title request costs one extra model call per chat**, on the first member's
  model. It is capped at 24 output tokens and 15 seconds, and it is skipped
  entirely once the title is not the default.
- **`maxAutoRounds: 1` implements without a review.** The hand-off's two rounds
  count towards the cap like any others, so a chat capped at one round stops
  after the executor with the `maxRoundsReached` notice. Exempting them was
  rejected (see `context.md`); the default is 3, where both rounds fit.
- **A hand-off is refused while a run is active** rather than queued, and the
  button is disabled in that state. A user who wants both has to wait or press
  Stop.
- **A run does not summarise itself.** With `maxAutoRounds` reached, the user
  gets a notice and has to read the rounds; PLAN's "ask an agent to summarise" is
  a later action.
