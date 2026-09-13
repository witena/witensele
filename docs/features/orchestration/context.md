# orchestration — Context

> **Status: implemented (S2.3).** S1.7 built the smallest `ChatRunner` that was
> still the real shape — one agent, one round, one abortable run. S2.3 turned it
> into the full engine: rounds, roundrobin / mention-only, sequential / parallel
> with a barrier, `@mention` scheduling, `[PASS]`, `maxAutoRounds`, and the
> decided handling of a user message that arrives mid-run. What is still missing
> S2.4 then plugged in the supervisor: offline agents are dropped from a round's
> speakers, and a turn the hard timeout skips releases the barrier like any other
> terminal status.

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

## What S2.4 added

| Change | Where |
|---|---|
| **Offline agents are not scheduled.** `supervisor.isOffline` is consulted at every round boundary, *after* the plan is computed so an `@mention` of an offline member still resolves | `#loop`, one filter over `plan.speakers` |
| **`allOffline`.** A round that had speakers but lost all of them to that filter finishes `completed` with a notice, rather than in silence | `NOTICE_ALL_OFFLINE` |
| **`skipped` in the barrier.** Nothing changed here: `allSettled` already treated every terminal status as complete, and `runAgentTurn` reports `aborted: false` for a timeout, so a skip is not read as a Stop | — |
| **The supervisor, the heartbeat and "retry this agent"** | [`presence`](../presence/context.md) |

## Out of scope (permanently, for this feature)

| Not here | Owned by |
|---|---|
| What one agent does during its turn, including parsing its finished text for `@name` | [`agent-turn`](../agent-turn/context.md) |
| The matching rule behind `@name` itself | `src/shared/mentions.ts`, shared with the composer |
| Persisting chats and messages, and the chat UI | [`chats`](../chats/context.md) |
| Heartbeat, timeouts, presence transitions, deciding *that* an agent is offline | [`presence`](../presence/context.md) |
| Tool execution | `mcp` (S3.1) |

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
| **Offline members are filtered out of `plan.speakers`, not out of `members`** | Drop them before the plan is computed | A reply that says `@Ghost` still resolves to a real member, so the round ends with the `allOffline` notice rather than with `noMentions` — the difference between "that agent is down" and "you mentioned nobody" |

## Open questions

- Whether a `max-rounds` finish should offer a "continue" action rather than
  making the user type something. The notice currently tells them to send a
  message.
- Whether an agent that recovers should be re-invited to the round it was skipped
  from. Today it simply speaks in the next one.
- Whether `parallel` should also snapshot the *member list* per round, so a
  removal during a round cannot change the roster the briefing prints mid-round.
