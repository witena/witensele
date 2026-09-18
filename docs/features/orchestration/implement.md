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
// S5.14: this chain's own cap when the message carried one, the chat's otherwise.
limit = roundsCap ?? chat.settings.maxAutoRounds
if (roundsSinceUser >= limit) {
  notice(roundsCap !== null ? 'voteClosed' : 'maxRoundsReached', { max: limit })
  reason = 'max-rounds'; break
}

round += 1; roundsSinceUser += 1
emit run.round { round, speakers: plan.speakers }
outcomes = await runRound(...)                    // the barrier; see below

if (aborted)                        { reason = 'stopped'; break }
if (outcomes.every(o => error))     { reason = 'error';   break }
carried = planFromReplies(memberIds, outcomes)    // self / non-members / passed dropped

// S5.14, in this order. The cap is re-checked here because a vote whose answers
// mention nobody schedules nothing and would leave through the branch above in
// silence; and agreement is only asked once nothing is left outstanding.
if (roundsCap !== null && roundsSinceUser >= roundsCap) {
  notice('voteClosed'); reason = 'max-rounds'; break
}
if (agreed(chat, members, outcomes, carried, stage)) {
  notice('consensus')
  await runClosing(chat, members, signal)         // one speaker, closing briefing
  reason = 'completed'; break
}
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

### A hand-off (S5.6, S5.12)

```
chat.handoff
  → ChatRunner.handoff({ chatId, intent? })      // intent defaults to 'implement'
      intent ∉ HANDOFF_INTENTS → throw validation
      chats.get(chatId)                          // not_found before anything is written
      chat.workdir  ?? throw validation('handoff_no_workdir')
      executor = first member with role 'executor'
                ?? throw validation('handoff_no_executor')
      intent === 'deliver' && no document deliverable
                → throw validation('handoff_no_deliverable')
      #running !== null → throw validation('handoff_run_active')
      messages.create({ senderType: 'user',
                        parts: [ intent === 'deliver'
                                   ? handoffDeliver notice { agent, path }
                                   : handoff notice { agent } ],
                        mentions: [executor.id] })
      emit message.created
      #handoff = { agentId: executor.id, intent }; #start()
  ← resolves with the stored message

… the loop …
  round 1: [executor]              (handoff: intent on that turn's briefing)
  round 2: [every other member]    (reviewing: true, fed by the executor's message)
  round 3+: ordinary @ scheduling, capped by maxAutoRounds
```

The four refusals are `ValidationReason`s rather than bare `validation`s, and the
renderer computes the **same four** from the chat record to decide whether to
enable either control (`components/chat/handoff.ts`), in the same order, so a
tooltip and a rejection can never name different rules. `handoff_no_deliverable`
sits third — after the two configuration rules and **before** the transient one —
so a chat that is running and has nothing to deliver is told about the
deliverable.

`intent` is validated for its *shape* in `handlers/chats.ts` and for what this
chat can satisfy in the runner, which is the same split the other three follow:
the handler knows what a well-formed request looks like, the runner is the only
object that holds the chat, its members and whether a run is going.

### Closing a discussion (S5.14, S5.16, S5.18)

```
round ends
  │
  ├─ roundsCap spent?      → notice('voteClosed')  → max-rounds
  │
  └─ agreed()?             → notice('consensus')
         │                    concluded = runClosing():
         │                      round += 1
         │                      emit run.round { round, speakers: [closingSpeaker()] }
         │                      runAgentTurn({ …, closing: true })
         │                      → its message gains a ConclusionPart (S5.16)
         │                      → true when that turn finished `done`
         │                    concluded && autoDeliverExecutor(chat, members)
         │                      && !isOffline(executor)?            (S5.18)
         │                      → #storeHandoff(chat, executor, 'deliver', path)
         │                        (the same row the button stores: notice + quote)
         │                      → round += 1: [executor]   handoff: 'deliver'
         │                      → round += 1: [everyone else not offline]  reviewing
         │                    → completed
         └─ otherwise       → next iteration
```

The automatic delivery (S5.18) is **not a third way to schedule a hand-off**: it
is `handoff()` minus the parts that only make sense for a button. `handoff()`
refuses to join a run (`handoff_run_active`), which is right for a click and
wrong for the run that has just produced the thing to deliver, so the storing
half was extracted into `#storeHandoff` and the two rounds are run inline with
the same `implementing` / `reviewing` stages `#loop` would have used. Nothing is
bypassed: the `write_file` permission prompt still stands in front of the file,
Stop aborts the executor's turn like any other, and an executor that is offline
gets no turn (the supervisor already dropped it from rounds). When any of the
conditions fails nothing at all happens — no notice, no round — and the chat is
what S5.16 left: a conclusion card with **Write to the deliverable** on it.

`agreed()` is five conditions, every one of them a way of being conservative —
not a hand-off's rounds, nothing mentioned, nothing pending, at least one
non-executor speaker finished, and every such speaker's text ending with
`[AGREED]`. (It was six until S5.16, which dropped "`roundrobin` only": a
`mention-only` round that mentions nobody is caught by "nothing mentioned", and
one that agreed without mentioning anybody is a chain with nothing left to do.)
They are listed with their reasons in
[`backend.md`](./backend.md#the-agreed-chain); the short version is that the
failure that matters is a discussion cut short, so "no marker" and "one
`[CONTINUE]`" both mean carry on.

The closing turn is an **ordinary round with one speaker**. Nothing about Stop,
the barrier, presence or usage needs a case for it; the only difference is
`AgentTurnOptions.closing`, which swaps the marker rule in the briefing for
"state the conclusion, add nothing, write no marker" and, since S5.16, puts a
`ConclusionPart` in front of the message's parts when the turn finished `done`.
Whatever it mentions is ignored, because the loop breaks straight after.

**Who speaks** is `closingSpeaker(chat, members, isOffline)`: the chat's
`settings.closingAgentId` when that member is present, available and not an
executor, and otherwise the first member in `position` order that is not offline
— S5.14's rule, kept as the fallback so a stale setting can only cost the
preference, never the conclusion.

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
| `max-rounds` | `roundsSinceUser` reached the chain's limit. The limit is `ChatSendInput.rounds` when the message carried one and `chat.settings.maxAutoRounds` otherwise; the notice is `voteClosed` in the first case and `maxRoundsReached` in the second (S5.14) |
| `completed`, via agreement | Every non-executor speaker of an ordinary round wrote `[AGREED]`, nothing was mentioned and nothing was pending: writes `consensus`, runs one closing turn, ends (S5.14). In **either** mode since S5.16 |
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
  send(input: { chatId, text, mentions?, rounds? }): Promise<Message>
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
| `src/renderer/src/stores/run.test.ts` | The composer's resolved mentions reaching `chat.send`, an empty list being omitted, and (S5.14) a `rounds` cap travelling with the send while an ordinary send carries none |
| `src/shared/markers.test.ts` | `isPassOnly` versus `closureMarker` versus `stripTrailingMarkers`: a bare token is an abstention and survives, a token after real content is a sign-off and goes, a token quoted mid-sentence is neither, two of them are both removed, and `closureMarker` is case-sensitive and answers `null` for `[PASS]` |
| `src/main/orchestration/chat-runner.test.ts` (`describe('ChatRunner (usage, truncation and titles)')`) | S4.1–S4.3 through the handlers: `messages.usageSummary` summing per agent and pricing a known model, an empty summary and `not_found`; the `contextTruncated` notice appearing once per run with the agent and the count, and not appearing when the history fits; a title generated from a mock model's `doGenerate`, sanitised, falling back when the generator returns `null` or throws, never replacing a title the user set or set later, and never written when every turn failed; a trailing `[PASS]` leaving the status `done` while disappearing from the next speaker's prompt; and `chats.search` finding a chat by a word in one of its messages |
| `src/main/orchestration/chat-runner.test.ts` (S5.11 cases) | The `materialsTruncated` notice: a chat whose goal marks a 400 KB file gets one notice naming the agent and the count, a second run adds no second notice, and a chat whose materials fit gets none |
| `e2e/polish.spec.ts` | Against a real local model: the header and member-row token counts, the automatic title replacing `New chat`, and the search box filtering the left column |
| `src/main/orchestration/chat-runner.test.ts` (`describe('ChatRunner (hand to executor)')`) | S5.6, nine cases: the stored message (a `user` row carrying the `handoff` key and mentioning only the executor), the executor speaking alone in a `roundrobin` chat followed by one review round with the other two in `position` order and their `inReplyTo`, the extended briefing in the handed-over turn's prompt and the executor's answer in the reviewers' prompts, no review round when the executor is the only member, a reviewer's `@` scheduling another executor round whose prompt no longer carries the hand-off briefing until `maxAutoRounds` takes the floor back, a Stop inside the executor's tool call leaving `permissions.pending()` empty and nothing on disk, and the three refusals |
| `src/main/orchestration/scheduling.test.ts` (S5.6 block) | `planFromHandoff` and `planFromReview`, including an executor that has left the chat and an executor that is the only member |
| `src/renderer/src/components/chat/handoff.test.ts` | `handoffBlocker`: the enabled case, the three refusals, a blank `workdir`, and the order the rules are applied in |
| `src/renderer/src/stores/run.test.ts` (S5.6 block) | `handoff` calling `chat.handoff` with nothing but the id, and a refusal keeping its `details` so the composer can name the reason |
| `e2e/orchestration.spec.ts` | Two real models: round-robin in round 1, parallel streaming both rows at once, `mention-only` answering with one member, and the `noMentions` notice |
| `e2e/closure.spec.ts` | S5.14 against a real local model: two agents prompted to agree immediately end with the `consensus` line and a closing message by the first member in round 2, with no `maxRoundsReached`; and "Start a vote" produces exactly one round and the `voteClosed` line. The first test asks up to three times in fresh chats — a 3B model writes the marker about three runs in four, which is a fact about the model, not the runner. Its S5.16 block needs **no model**: it pushes a `message.created` carrying a `ConclusionPart` down the app's own event channel and asserts the card, the Copy button against the real clipboard, the header chip scrolling a conclusion back into view past thirty messages, and the chat-list preview |
| `e2e/executor.spec.ts` | Offline: the hand-off button's `data-blocked` naming the rule that disabled it, and the backend refusing on the same rule. Behind the `qwen2.5:3b` guard: two participants plus an executor discuss, "Hand to executor" is clicked, the permission prompt is allowed, a file appears in the folder and a participant speaks again |
| `src/main/orchestration/chat-runner.test.ts` (`describe('ChatRunner (discussion closure)')`) | S5.14, nineteen cases. **Agreement**: unanimous `[AGREED]` producing the notice, one closing round with the first member alone and the conclusion it wrote; the notice stored before the conclusion; the closing prompt carrying the closing block and *not* the marker rule while the discussion prompt carries the reverse; one `[CONTINUE]` and no marker at all both carrying on; a pending `@mention` postponing the close to the round that answers it; an executor's marker-free reply not blocking it; a round of nothing but `[PASS]` never closing; `mention-only` stripping the markers and ignoring them; and the marker being absent from the next speaker's prompt. **The cap**: `rounds: 1` running exactly one round and closing with `voteClosed`; the same when the answers mention nobody; the cap winning over agreement; a cap of 2 running two; the cap not leaking into the next message; and four refusals |
| `src/main/orchestration/chat-runner.test.ts` (`describe('the conclusion as a message (S5.16)')`) | Six cases: the `ConclusionPart` first on the closing message and on nothing else in the transcript; the flag absent from `toModelMessages` while that message's text is present; the chat's `closingAgentId` getting the closing round; the fallback to the first member when it names nobody and when it names the executor; and a cleared setting (`null`) going back to the first member. Beside them, in the same file: `mention-only` closing when its round agreed and mentioned nobody, and carrying on when it mentioned somebody; and the two `deliver` hand-off cases — the latest conclusion quoted as `> ` lines in the stored message and in the executor's prompt, nothing quoted when the chat has none, and nothing quoted for `implement` |
| `src/main/agents/agent-turn.test.ts` (S5.16 cases) | `closing: true` producing the flag first in `parts` and in the stored row; an ordinary turn producing none; a closing turn that **failed** producing none; and `markConclusion`'s three cases |
| `src/renderer/src/components/chat/conclusion.test.ts` | `latestConclusion` (none, the last of several, never a non-agent message), `conclusionPreview` (first non-empty line, a leading heading marker skipped, the cap, and `null` for a flag with no text) and `deliverableBlocker` (the enabled case and the four refusals in the backend's order) |
| `src/renderer/src/components/chat/transcript-rows.test.ts` (S5.16 cases) | The row model marking a conclusion row and only that row, and `isConclusion` reading the flag wherever it sits |
| `src/main/agents/history.test.ts` (S5.16 cases) | A conclusion's text in the prompt with no trace of the flag, and a message that is nothing but the flag dropped entirely |
| `src/main/handlers/chats.test.ts` / `src/main/db/chats.test.ts` (S5.16 cases) | `closingAgentId` stored, cleared with `null` back to an **absent** field, surviving the JSON round trip, and refused when it is not a non-empty string |
| `src/main/orchestration/chat-runner.test.ts` (S5.12 cases) | `intent: 'deliver'` storing the `handoffDeliver` key with the agent and the relative path while scheduling the same two rounds; the executor's prompt carrying the deliver paragraph and the path and *not* the implement one; the notice reaching the reviewers as prose; the review round's prompts carrying the review block while the executor's does not, and the round after it carrying neither; the refusal with no goal and with a `codebase` goal; the folder and the executor still checked first; and an unknown intent refused |

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
- **The review round is briefed, not verified.** S5.12 tells the reviewers to
  judge the change against the goal; nothing checks that they did, and a `[PASS]`
  from every reviewer ends the run as an approval nobody wrote.
- **A `deliver` hand-off is not told whether it worked.** The runner schedules
  the review round whether or not the deliverable appeared; it is the turn's own
  `FileRefPart` and the header chip that say so, and a reviewer reading a chat
  where nothing was written has to notice that for itself.
- **A run does not summarise itself** *unless the group agreed*. S5.14's closing
  turn is exactly that summary, but only on the consensus path: a chain that ends
  at `maxAutoRounds`, or because nobody was mentioned, still leaves the user to
  read the rounds, and the Actions card's "Summarise" is the manual version.
- **Agreement is only as good as the marker.** A model that ignores the briefing
  never writes `[AGREED]`, and the discussion then ends the way it did before
  S5.14. Small local models are unreliable here: `e2e/closure.spec.ts` measures
  roughly three runs in four for `qwen2.5:3b` even with a system prompt written
  for the purpose.
- **`[AGREED]` is stripped from the history**, like `[PASS]`, so a later speaker
  cannot see who has already agreed — and cannot learn the protocol from the
  transcript either. Recorded as an open question in `context.md`.
- **The closing turn is one member, chosen once.** S5.16 made *which* member a
  setting (`ChatSettings.closingAgentId`); with none, the speaking order the user
  set is still the tie-break. Nothing derives the speaker from the discussion —
  the member the group deferred to, or the one with the largest context, would
  need a signal the transcript does not carry.
- **The conclusion is the latest one, everywhere.** A chat that agreed twice has
  two cards in its transcript, but one header chip, one chat-list preview and one
  quoted conclusion in a `deliver` hand-off, and all three mean the newest.
- **The chat-list preview only covers chats that have been opened.** It is
  computed from the transcripts the messages store holds, so a chat whose
  transcript has never been loaded shows the member count it always showed. A
  preview for every chat would be a query of its own.
- **A `rounds` cap has no UI of its own.** It is reachable only through "Start a
  vote", which hard-codes `1`; there is no way to say "answer twice" from the
  composer.
