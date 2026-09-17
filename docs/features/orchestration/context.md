# orchestration — Context

> **Status: implemented (S2.3).** S1.7 built the smallest `ChatRunner` that was
> still the real shape — one agent, one round, one abortable run. S2.3 turned it
> into the full engine: rounds, roundrobin / mention-only, sequential / parallel
> with a barrier, `@mention` scheduling, `[PASS]`, `maxAutoRounds`, and the
> decided handling of a user message that arrives mid-run. What is still missing
> S2.4 then plugged in the supervisor: offline agents are dropped from a round's
> speakers, and a turn the hard timeout skips releases the barrier like any other
> terminal status. **S5.6** added the second way a run can start: "Hand to
> executor", which schedules the executor alone and then one review round.
> **S5.14** added the two ways a chain now ends on its own: the group writing
> `[AGREED]`, and a message that carried its own round cap. **S5.16** made what
> that produces a *thing*: the closing message carries a `ConclusionPart`, the
> chat says who writes it, and `mention-only` closes as well.

## Problem

A chat is not a request/response API. A user message starts a *run*: one or more
rounds, each with one or more speakers, each speaker taking a turn, the whole
chain interruptible at any moment, and the transcript the single source of truth
throughout. `ChatRunner` is the thing that decides **who speaks and when**, and
that owns the `AbortController` the Stop button reaches.

## Scope

- One `ChatRunner` per chat, held by `ChatRunnerRegistry` on the `AppContext`.
- `send`: persist the user message with its effective mention set, emit
  `message.created`, then either start a run or add the message to the pending
  list of the run that is already going.
- The **round loop**: speakers of round 1 from the chat's `mode`, speakers of
  every later round from the `@mentions` of the round that just ended, until
  nothing is scheduled or `maxAutoRounds` is reached.
- **Speaking modes**: `sequential` (one turn after another, each rebuilding the
  transcript) and `parallel` (one snapshot, all turns at once, awaited together).
- `[PASS]` as an abstention that schedules nobody.
- `stop`: abort every active turn of the current round and drop what is pending.
- The four `run.finished` reasons, the two `system-notice` messages the engine
  writes (`noMentions`, `maxRoundsReached`) and the one it writes when it fails
  (`runFailed`).
- `RunState` through `ChatRunnerRegistry.getState(chatId)`: the round, its
  speakers, the turns in flight and the pending user messages.
- **`handoff`** (S5.6): the second entry point. It stores a `user` message
  carrying the `handoff` notice key and mentioning the chat's executor, then runs
  the executor alone — whatever the chat's `mode` — followed by exactly one
  review round with every other member. It refuses with a `ValidationReason`
  when the chat has no folder, no executor, or a run in flight.
- **The `contextTruncated` notice** (S4.2): the turn measures, the runner tells,
  once per run per agent.
- **The `materialsTruncated` notice** (S5.11): the same shape with a different
  grain — the turn reports `materialsOmitted`, the runner tells **once per
  chat**, because the goal's materials are the same in every round of every run
  until the user edits the list, while what a truncated history hides keeps
  changing.
- **The automatic chat title** (S4.3): after the first run that produced a
  finished reply, and only while the title is still the default.
- **Discussion closure** (S5.14, S5.16): reading `[AGREED]` / `[CONTINUE]` off
  the round that just ended, in **both** modes; the `consensus` notice; the
  single **closing turn**, given to `ChatSettings.closingAgentId` when it can be
  and to the first eligible member otherwise; and `ChatSendInput.rounds` with its
  `voteClosed` notice.
- **The conclusion quote** (S5.16): a `deliver` hand-off stores the chat's latest
  conclusion as a block quote beside its notice, so the executor is told which
  answer to write out.

## What S2.4 added

| Change | Where |
|---|---|
| **Offline agents are not scheduled.** `supervisor.isOffline` is consulted at every round boundary, *after* the plan is computed so an `@mention` of an offline member still resolves | `#loop`, one filter over `plan.speakers` |
| **`allOffline`.** A round that had speakers but lost all of them to that filter finishes `completed` with a notice, rather than in silence | `NOTICE_ALL_OFFLINE` |
| **`skipped` in the barrier.** Nothing changed here: `allSettled` already treated every terminal status as complete, and `runAgentTurn` reports `aborted: false` for a timeout, so a skip is not read as a Stop | — |
| **The supervisor, the heartbeat and "retry this agent"** | [`presence`](../presence/context.md) |

## What S5.6 added

| Change | Where |
|---|---|
| **`ChatRunner.handoff`** and `ChatRunnerRegistry.handoff`, behind the `chat.handoff` method | `chat-runner.ts`, `handlers/chats.ts` |
| **Two staged rounds.** `#handoffTo` is taken once at the top of `#loop`; the first iteration merges `planFromHandoff`, the second `planFromReview`, and the third is ordinary `@` scheduling again | `#loop`, `scheduling.ts` |
| **`implementing`**, the agent handed the work this round, which becomes `AgentTurnOptions.handoff` for that one turn and extends its briefing | `#runRound`, [`executor`](../executor/context.md) |
| **The `handoff` notice key**, on a `user` message rather than a `system` one | `NOTICE_HANDOFF` |
| **Three `ValidationReason`s** — `handoff_no_workdir`, `handoff_no_executor`, `handoff_run_active` — and the button that reads the same three rules before offering the action | `shared/types.ts`, `components/chat/handoff.ts` |

## What S5.12 added

| Change | Where |
|---|---|
| **`intent` on the hand-off** — `implement` (the default, S5.6 unchanged) or `deliver` — carried on `chat.handoff` and stored on `#handoff` beside the executor id | `chat-runner.ts`, `shared/types.ts` |
| **A second notice key**, `handoffDeliver`, naming the agent *and* the deliverable's relative path | `NOTICE_HANDOFF_DELIVER`, `agents/history.ts` |
| **A fourth `ValidationReason`**, `handoff_no_deliverable`, refused after the folder and the executor and **before** the run check, so the configuration mistake is reported ahead of the transient one | `shared/types.ts`, `components/chat/handoff.ts` |
| **`reviewing`**, the other half of `implementing`: true for every speaker of the review round, and the only thing that sets `AgentTurnOptions.reviewing` | `#runRound`, [`agent-turn`](../agent-turn/context.md) |

The scheduling is **untouched**: the same two staged plans, the same merge, the
same cap. An intent changes one paragraph of one prompt and one stored key; a
review round changes one section of the prompts of the round after it.

## What S5.14 added

Two ways a chain ends that are not "nobody was mentioned" and not
"`maxAutoRounds`".

| Change | Where |
|---|---|
| **`#agreed`**: after an ordinary `roundrobin` round, every non-executor speaker that finished wrote `[AGREED]`, nothing is mentioned and nothing is pending | `chat-runner.ts`, `@shared/markers` |
| **The `consensus` notice**, stored before the closing turn so the transcript reads in the order things happened | `NOTICE_CONSENSUS` |
| **`#runClosing`**: one extra round of exactly one speaker — the first member in speaking order that is not offline — with `AgentTurnOptions.closing`, after which the loop breaks | `chat-runner.ts`, [`agent-turn`](../agent-turn/context.md) |
| **`ChatSendInput.rounds`**, held in `#pendingRounds` and taken at the same boundary that resets `roundsSinceUser`; it caps **that chain only** | `chat-runner.ts`, `handlers/chats.ts` |
| **The `voteClosed` notice**, and the cap checked at the *end* of a round as well as at the top of one | `NOTICE_VOTE_CLOSED` |
| **`[AGREED]` / `[CONTINUE]` in the group briefing**, one rule beside `[PASS]`, in both languages | [`agent-turn`](../agent-turn/context.md) |

The scheduling is again **untouched**: `scheduling.ts` has no new function, no
plan is built differently, and the closing turn is an ordinary round with one
speaker. What changed is the set of reasons the loop may `break`.

## What S5.16 added

S5.14 produced a conclusion and then drew it as one more reply. This step makes
it a first-class message, and fixes two things the same rule got wrong.

| Change | Where |
|---|---|
| **`ConclusionPart`**, a flag part stored first on the closing turn's message when it finished `done` | [`agent-turn`](../agent-turn/context.md), `markConclusion` |
| **`closingSpeaker`**: `ChatSettings.closingAgentId` when that member is present, available and not an executor; the first non-offline member otherwise, which is S5.14's rule unchanged | `chat-runner.ts`, [`chats`](../chats/context.md) |
| **`mention-only` closes too.** `#agreed` no longer asks which mode the chat is in: a round whose speakers all agreed and mentioned nobody ends the chain in either mode | `#agreed` |
| **`conclusionQuote`**: a `deliver` hand-off's user message gains a second part — the latest conclusion as a markdown block quote — so the instruction names the answer even after `fitHistory` has trimmed it away | `chat-runner.ts` |

No new notice key, no new backend method, no migration: a part is a member of an
open union, and a setting is one field of a JSON column.

## Out of scope (permanently, for this feature)

| Not here | Owned by |
|---|---|
| What one agent does during its turn, including parsing its finished text for `@name` | [`agent-turn`](../agent-turn/context.md) |
| The matching rule behind `@name` itself | `src/shared/mentions.ts`, shared with the composer |
| Persisting chats and messages, and the chat UI | [`chats`](../chats/context.md) |
| Heartbeat, timeouts, presence transitions, deciding *that* an agent is offline | [`presence`](../presence/context.md) |
| Tool execution | `mcp` (S3.1 `[x]`) and `agent-turn`. The runner never sees a tool: a turn with a tool loop is still one turn |

## Dependencies

| Feature | What this one needs from it |
|---|---|
| [`agent-turn`](../agent-turn/context.md) | `runAgentTurn`, its promise that it never throws and always leaves a terminal status, the optional `history` snapshot and the `inReplyTo` it stores |
| [`database`](../database/context.md) | `ChatRepository.listMembers`, `AgentRepository.get`, `MessageRepository.create` / `listForContext` |
| [`chats`](../chats/context.md) | The handlers that call it, the `ChatSettings` it schedules against, and the renderer that reduces its events |
| [`i18n`](../i18n/context.md) | The `notices.*` keys its system messages carry; the sentences live in the renderer |

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| **A message sent during a run is stored immediately and joins the run at the next round boundary.** It resets the automatic-round counter and its speakers are merged with the ones the finished round mentioned | Abort the current turn and restart; refuse the send; hold the text in memory; answer it in a *separate* run afterwards (S1.7's behaviour) | Aborting throws away a half-generated answer the user already paid for, and with several agents it would abort the ones that had nothing to do with the interruption. Refusing loses what the user typed. A separate run splits one conversation into two and makes the composer flicker between Stop and Send. Storing it now also means the next turn needs no special handling: every turn rebuilds its view from the whole transcript |
| **`round` is monotonic within a run** and is not reset when a pending user message restarts the counting | Reset it whenever the user speaks; number rounds globally per chat | The number is a label printed on every message; a run whose labels went 1, 2, 1, 2 would be unreadable. The cap counts separately in `roundsSinceUser`. A *new* run does start again at 1, which is what makes "Round 1" mean "the first answer to what you just asked" |
| **`maxAutoRounds` counts the round the user triggered.** `maxAutoRounds: 1` means "answer me once, then give me the floor back" | Count only the rounds nobody asked for | The setting is the user's promise that the chat will not run away; a cap that ignored the first round would always run N+1 and the label in the member panel would be off by one |
| **An errored turn does not end the round or the run**; only a round in which *every* speaker errored finishes the run with `error` | Any error ends the run (S1.7); errors never end it | One provider being down must not silence the members that work. A round where nobody got through, though, is a chain with nothing to continue from |
| **Parsing a reply's `@mentions` lives in `agent-turn`, scheduling lives here** | Parse in the runner after the turn | The finished text is in the turn, and parsing there keeps one `message.updated` per turn instead of two. The runner reads `message.mentions` and decides who that makes speak — which is where the self-mention, the non-member and the `[PASS]` are dropped |
| **Speaker order is always `position` order**, never mention order | Order by who was mentioned first | The member order is the one thing the user sets by hand (S2.2's drag handle); an order that depended on which name a model typed first would make that control a lie |
| **`@all` / `@everyone` mean every member** | Only explicit names | Models reach for it, and the alternative is a reply that mentions four people by name to say one thing. A member actually named "all" still wins, because a name is more specific than a keyword |
| **Parallel hands every speaker the same snapshot** | Let each turn read the database when it starts | Otherwise "replies within a round are not visible to each other" (PLAN) would be a race: a fast model's row would appear in a slower sibling's prompt depending on timing |
| **Membership and settings are re-read every round** | Once per run (S1.7); cached on the runner | A member added or the mode switched mid-run takes effect at the next boundary, which is the same boundary a pending message lands on. One rule, one moment |
| A run with no members emits **nothing** | Emit `run.started` + `run.finished { error }` | A chat the user has emptied is not an error; emitting a run would make the composer wait for a reply that was never scheduled |
| **`mention-only` with no mentions writes a notice** | Finish silently | Silence is indistinguishable from a failure. The notice says which rule applied, and `history.ts` renders it into later prompts so the models see it too |
| Stop writes **no** notice | Write `runStopped` | The interrupted message already says "Stopped" on its own row, and a second line for the same fact would double every cancelled exchange in the transcript. The key stays in the locale files, unused |
| **A hand-off is a method of its own, not a message with a magic prefix** | `chat.send` with a well-known text; a `handoff` flag on `chat.send` | The two rounds it schedules are not what any `mode` describes, and the refusals (no folder, no executor, a run in flight) are about the *run*, not about the text. A prefix would also be one copy-paste away from being triggered by an agent |
| **What it stores is an ordinary `user` message**, whose only part is the `handoff` notice key | A `system` message; a flag on the chat; nothing at all | It *is* the user speaking: it is what the executor replies to, it carries the mention that schedules the turn, and it is what a reader scrolling back has to see. A `system` row would be the app narrating an instruction the user gave. The key rather than a sentence is CLAUDE.md rule #4, which also means `history.ts` renders it into prompts in its own English |
| **The executor speaks alone, whatever `mode` says**, and the review round runs whatever `mode` says | Respect `mode` in both rounds | PLAN.md's one-writer rule is the whole point: a `roundrobin` chat putting four models in front of the executor would bury the request, and a `mention-only` chat would answer a hand-off with a `noMentions` notice instead of a review |
| **The review round is everybody except the executor** | Only `role === 'participant'` members | They are the same set in every chat the rules allow. They differ only in S5.2's known gap — a second executor promoted into a chat — and there the extra agent has no tools and nothing to lose by reviewing. "Whoever did not just write the code reads it" also survives a third role |
| **A hand-off cannot join a running chain**; it is refused while a run is active | Queue it like a user message | A hand-off's rounds are scheduled, not merged: joining a round somebody else's mentions already filled would make "the executor speaks alone" untrue, and the click would silently mean something else than it said |
| **`maxAutoRounds` counts the hand-off's rounds like any others** | Exempt the implement + review pair | The setting is the user's promise that the chat will not run away, and a hand-off is the *most* expensive thing in the product to let run away. The cost is that `maxAutoRounds: 1` implements without a review, which the `maxRoundsReached` notice explains — recorded in "Known limitations" rather than hidden |
| **Offline members are filtered out of `plan.speakers`, not out of `members`** | Drop them before the plan is computed | A reply that says `@Ghost` still resolves to a real member, so the round ends with the `allOffline` notice rather than with `noMentions` — the difference between "that agent is down" and "you mentioned nobody" |
| **Agreement is read from a marker the model writes, not inferred** (S5.14) | Ask a model "has the group agreed?" after each round; compare replies for similarity | An extra model call per round costs a round-trip and can be wrong in both directions, and similarity is not agreement — two members can restate the same position while one of them still objects. A marker is the group's own answer, it costs nothing, and the briefing already teaches one token of exactly this shape (`[PASS]`) |
| **No marker at all means "carry on"**, and so does a single `[CONTINUE]` | Treat a missing marker as agreement; require every member to have spoken | The failure that matters is a discussion cut short, not one that runs a round too long. A model that ignored the protocol has said nothing about whether the group is finished, and reading silence as consent would end chats the moment a member forgot the rule |
| **Executors do not vote**, and a hand-off's two rounds are exempt entirely | Count every speaker | An executor writes files rather than positions; a chat with one would otherwise need it to agree before the participants could finish. A reviewer with nothing to add is not a discussion reaching a conclusion either, so S5.6's rounds keep their own behaviour |
| **One closing turn by one member** — the chat's `closingAgentId` since S5.16, and the first in speaking order when it has none | The last speaker; every member; no closing turn, only the notice | A conclusion is one voice, and the member order is the ordering the user set by hand, so a chat that has chosen nobody closes with the same voice every time. Without the turn the user is left to read four replies and work out what was decided, which is the thing the product exists to do for them |
| **The setting may not name an executor, but the fallback may reach one** (S5.16) | Exclude executors from both; allow one to be chosen | Choosing the executor as the group's voice is choosing the member that did not vote on the consensus, so the control refuses it. The fallback is S5.14's rule untouched, and a chat whose only available member is an executor must still hand back an answer rather than silently skip the conclusion |
| **`mention-only` closes on the same rule as `roundrobin`** (S5.16) | Leave it `roundrobin`-only, as S5.14 had it | What ends a chain is that everybody who spoke is finished **and** nothing is left scheduled, and in `mention-only` the second half is the stronger statement: the speakers were the ones that were asked for and they asked for nobody. A round that mentions somebody still carries on, which is that mode's own rule and needed no code |
| **A `deliver` hand-off quotes the conclusion; an `implement` one does not** (S5.16) | Quote in both; quote in neither and rely on the transcript | "Write the deliverable" names one answer, and the transcript it is in is budgeted — the oldest messages fall out of a long prompt while the instruction never does. An `implement` hand-off is handed the whole discussion above it, and quoting one message of it would narrow the request |
| **The closing briefing replaces the marker rule rather than adding to it** | Append "this is the closing turn" to the existing rules | A turn told both "end with a marker" and "write no marker" writes one. The block is last, and the rule it contradicts is simply absent |
| **`rounds` travels on the message, not on the chat** | A `maxAutoRounds` write before the send and another after it | Two writes with a run between them is a setting the user never chose, visible in the member panel, and wrong for ever if the app is closed in between. The cap belongs to one request and dies with its chain |
| **A capped chain is checked again at the end of a round** | Only at the top of the next round, like `maxAutoRounds` | A vote whose answers mention nobody schedules nothing, so the loop would exit through the empty-plan branch in silence and the user would never be told the vote was the point |
| **The cap wins over consensus when both apply** | Close with the conclusion instead | The user named the number. One round means one round, and `voteClosed` says exactly what happened |

## Open questions

- Whether a hand-off should be allowed to **queue** behind a running chain rather
  than being refused, now that the button is disabled in exactly that state
  anyway.
- Whether `maxAutoRounds: 1` should still buy the review round. Today it does
  not: the executor implements and the cap takes the floor back.
- Whether a `max-rounds` finish should offer a "continue" action rather than
  making the user type something. The notice currently tells them to send a
  message.
- Whether an agent that recovers should be re-invited to the round it was skipped
  from. Today it simply speaks in the next one.
- Whether `parallel` should also snapshot the *member list* per round, so a
  removal during a round cannot change the roster the briefing prints mid-round.
- Whether the closing speaker should be **derived** rather than configured — the
  member the group deferred to, or the one with the largest context window —
  and how that would be decided without a second model call. S5.16 answered the
  "who" with a setting, which is a choice the user makes once, not one the
  transcript makes per discussion.
- Whether a chat should be able to hold **more than one** current conclusion, for
  a discussion that agreed on two separable questions. Today the latest one wins
  everywhere: the header chip, the chat-list preview and the `deliver` quote.
- Whether `[AGREED]` should survive into the history transform, so a later
  speaker can see who has already agreed. Today it is stripped like `[PASS]`,
  which also means a small model cannot learn the protocol from the transcript.
