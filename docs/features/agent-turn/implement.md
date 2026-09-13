# agent-turn — Implementation

## Approach

Four modules, each a pure function except the last:

| Module | Shape |
|---|---|
| `briefing.ts` | `(language, self, members) → string`, delegating to `briefing.en.ts` / `briefing.zh-CN.ts`. Also `resolveMainLanguage(setting)` |
| `history.ts` | `(self, agentsById, userName, messages) → ModelMessage[]` |
| `default-agent.ts` | `ensureDefaultAgent(ctx)`, documented under [`chats`](../chats/backend.md) |
| `agent-turn.ts` | `runAgentTurn(options) → AgentTurnResult`; the only one with side effects |

`runAgentTurn` takes its storage, its event sink and its model by injection and
imports no electron, so the whole feature is exercised in vitest against a
temporary database file and a `MockLanguageModelV4` (CLAUDE.md rule #5).

## Data flow

```
ChatRunner picks a speaker
  │
  ├─ messages.create({ parts: [], status: 'streaming', round })   → message.created
  ├─ supervisor.beginTurn → presence.changed { working }
  │
  ├─ system  = agent.systemPrompt + "\n\n" + buildGroupBriefing(...)
  ├─ messages = toModelMessages({ self, agentsById,
  │               messages: options.history ?? listForContext(chat) })
  ├─ streamText({ model, system, messages, abortSignal, maxOutputTokens?, temperature? })
  │
  └─ for await (part of result.fullStream)
        every part      → supervisor.activity   (emits only when it clears `away`)
        text-delta      → append to the in-memory parts → message.delta { kind: 'text' }
        reasoning-delta → …                            → message.delta { kind: 'reasoning' }
        finish          → usage = toUsage(part.totalUsage)
        abort           → aborted = true
        error           → failure = message
        ↳ every 500 ms or 40 deltas: messages.update({ parts })

  ├─ timedOut = isTimeoutAbort(turnSignal.reason)
  ├─ mentions = passed || skipped ? [] : parseMentions(text, members)
  ├─ messages.update({ parts, status, mentions, usage?, error? })  → message.updated
  ├─ timedOut → messages.create(agentSkipped notice)               → message.created
  └─ supervisor.endTurn   → presence.changed { available | offline }
```

`abortSignal` above is **not** the run's signal. The turn creates an
`AbortController` of its own and forwards the run's abort into it, so Stop still
reaches every speaker of a round while the supervisor's hard timeout reaches
exactly one. `AbortSignal.reason` is what says which happened.

The final block runs on **every** path — normal finish, abort, provider failure,
even a signal that was already aborted before the first request — because a row
left in `streaming` shows a cursor forever.

### Terminal status

| Condition | `status` | `error` |
|---|---|---|
| The stream finished and the trimmed text is exactly `[PASS]` | `passed` | — |
| The stream finished otherwise | `done` | — |
| The turn was aborted with a `TimeoutAbortReason` (the supervisor's hard timeout) | `skipped` | `'timeout'` |
| Otherwise aborted, or an `abort` part arrived (the user pressed Stop) | `error` | `'aborted'` |
| Anything else failed | `error` | the provider's message |

A `skipped` turn also inserts an `agentSkipped` system message and returns
`aborted: false`, so the round barrier treats it as a completed turn rather than
as the run having been stopped.

### History transform

| Source message | Becomes |
|---|---|
| The user's | role `user`, prefixed `[User]: ` |
| Another agent's | role `user`, prefixed `[Name]: ` |
| **This** agent's | role `assistant`, no prefix |
| A system notice | role `user`, prefixed `[system]: `, rendered from the key into short English |

Then: consecutive same-role messages are merged with a blank line (several
providers reject two adjacent user messages, and one round of three agents
produces exactly that), and empty, `passed` and `skipped` messages are dropped.

### The group briefing

Per PLAN's "One agent turn": the member list with descriptions, which member the
agent is, that other members arrive as `[name]:` prefixed user messages, `@name`
to call on someone, and `[PASS]` to abstain. Both language files say the same
things in the same order, so they can be diffed side by side.

## Key types and contracts

```ts
runAgentTurn({
  ctx, chat, agent, members, round, signal,
  inReplyTo?,    // agent ids (plus 'user') stored on the message for the UI label
  history?,      // a transcript snapshot; omitted, the turn reads listForContext itself
  model?,        // already built; otherwise createModel builds one
  createModel?,  // default: resolveProvider + createLanguageModel
  onEvent?       // default: ctx.events.emit
}): Promise<{ message: Message; status: MessageStatus; aborted: boolean }>
```

`history` is what makes the two speaking modes differ: **sequential** omits it,
so every turn re-reads the transcript and sees the replies given earlier in the
same round; **parallel** reads it once at the start of the round and passes the
same array to every speaker, so the round's replies are invisible to each other
by construction rather than by timing.

Constants other modules and tests rely on: `FLUSH_INTERVAL_MS` (500),
`FLUSH_EVERY_DELTAS` (40), `ABORTED_ERROR` (`'aborted'`), `PASS_TOKEN`
(`'[PASS]'`), `DEFAULT_USER_NAME` (`'User'`), `SYSTEM_SENDER_NAME` (`'system'`).

| Event | Payload | Emitted when |
|---|---|---|
| `message.created` | `{ message }` | The empty `streaming` row is inserted |
| `message.delta` | `{ chatId, messageId, delta }` | Once per `text-delta` / `reasoning-delta` |
| `message.updated` | `{ message }` | The turn reaches its terminal status |
| `presence.changed` | `{ presence }` | `AgentSupervisor` emits it; the turn calls `beginTurn` / `activity` / `endTurn` |
| `message.created` | the `agentSkipped` notice | The hard timeout skipped this turn |

Presence belongs to `AgentSupervisor` ([`presence`](../presence/implement.md)),
not to this file: the turn only reports that a turn *began*, that something
arrived, and how it *ended*. The supervisor owns the session, the heartbeat, the
`away` / `offline` transitions and the abort that produces a `skipped` message.

## Tests

| File | Covers |
|---|---|
| `src/main/agents/history.test.ts` | Every rule in the table above, one case each: prefixes, roles, the unknown-agent fallback, merging in both directions, dropping `passed` / `skipped` / empty / streaming, reasoning excluded, notices rendered and unknown keys skipped, and the same transcript producing a different view per agent |
| `src/main/agents/briefing.test.ts` | Both languages: every member listed with its description, the agent told which one it is, the `[name]` and `@name` protocols, the `[PASS]` rule, the two languages differing, the one-member fallback, and `resolveMainLanguage` |
| `src/main/agents/agent-turn.test.ts` | The real `streamText` against `MockLanguageModelV4.doStream`: the event order, one delta per token, the empty `streaming` row, the presence pair, V4 usage mapping, reasoning as its own part and kind, `[PASS]` (and `[PASS]` *inside* a sentence not counting), provider failure, an already-aborted signal, a mid-stream abort keeping what arrived, the flush writing more than once, the prompt carrying the agent's own instructions plus the briefing plus the prefixed history, `temperature` / `maxOutputTokens` reaching the call, `createModel` being used when no model is passed, and — from S2.3 — the parsed `mentions`, no mentions on a `[PASS]`, `inReplyTo` stored (and absent when nobody asked), and a prebuilt `history` being used instead of the live transcript |
| `src/main/agents/default-agent.test.ts` | Creating exactly one agent on the first usable provider, reusing it, preferring a user-created agent, and the `validation` refusal |

## Known limitations and TODOs

- **No tools.** `streamText` runs with no `tools` and no `stopWhen`, so a model
  that wants to call one simply answers in prose. S3.1 adds the loop.
- **No skills or memory in the system prompt.** PLAN's assembly order ends with
  the skill headers and the memory index; S3.2 and S3.3 append them.
- **No context truncation.** A long chat eventually exceeds the model's window and
  the provider errors; S4.2 drops oldest-first while keeping the system prompt.
- **The user's display name is a constant** (`'User'`). There is no user profile
  yet; the server version gives it one.
