# agent-turn — Context

## Problem

One agent speaking once. Everything between "it is your turn" and "here is your
message, finished": build the prompt this agent should see, call the model, stream
the answer into a message row the user is already watching, and leave that row in
a state that cannot be mistaken for "still going".

It is the smallest unit of the product, and the one place where a wrong decision
is invisible rather than loud — a missing `[name]:` prefix or a replayed `[PASS]`
does not throw, it just makes every answer slightly worse.

## Scope

- **System prompt assembly**: the agent's own `systemPrompt`, then the group
  briefing.
- **The group briefing** in both languages (`briefing.ts` + `briefing.en.ts` +
  `briefing.zh-CN.ts`), following the UI language setting.
- **History transform** (`history.ts`): the shared transcript → this agent's
  `ModelMessage[]`.
- **The streaming turn** (`agent-turn.ts`): `streamText`, `fullStream`, the
  `message.delta` events, the periodic flush to SQLite, the terminal status, the
  usage, and the supervisor registration (`beginTurn` / `activity` / `endTurn`)
  around the turn.
- **Parsing the finished text for `@mentions`** (S2.3) and storing them on the
  message. *Who* that makes speak next is `orchestration`'s decision, not this
  one's.
- Storing the `inReplyTo` the caller passed, and accepting a **prebuilt history
  snapshot** so a parallel round can hand every speaker the same transcript.

## Out of scope

| Not here | Owned by |
|---|---|
| Who speaks and when | `orchestration` |
| Deciding who the `@mentions` in a reply make speak next | `orchestration` |
| The `@name` matching rule itself | `src/shared/mentions.ts`, shared with the composer |
| Tools: MCP, `read_skill`, `memory_*`, and the `stopWhen` loop around them | `mcp` (S3.1), `skills` (S3.2), `memory` (S3.3) |
| Heartbeat, stall / hard timeouts, deciding *when* to abort, the presence state machine | [`presence`](../presence/context.md). The turn owns the controller that gets aborted, and the `skipped` status that results |
| Context overflow and truncation | S4.2 |
| Cost accounting on top of the stored `Usage` | S4.1 |

## Dependencies

| Feature | What this one needs from it |
|---|---|
| [`providers`](../providers/context.md) | `resolveProvider` (the one place a key is decrypted) and `createLanguageModel` |
| [`database`](../database/context.md) | `MessageRepository.create` / `update` / `listForContext` |
| [`backend-client`](../backend-client/context.md) | The event bus and the `message.*` / `presence.changed` payloads |
| [`i18n`](../i18n/context.md) | The *setting* only. The briefing is model-facing text, not UI copy, and does not live in the locale files |

`orchestration` depends on this feature: `ChatRunner` calls `runAgentTurn` once
per speaker and reads the returned status to decide how the run ends.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| The message row is created **empty and `streaming`** before the request | Insert it when the first token arrives | A crash mid-stream then leaves a visible, explicable message instead of nothing, and the renderer has something to attach deltas to from the first event |
| Partial text is flushed to SQLite every 500 ms or 40 deltas | Write only at the end; write on every delta | Every-delta is a write per token; end-only loses a long answer to a crash. Two cheap counters buy most of the durability |
| A **user Stop** is `status: 'error'` with `error: 'aborted'`; a **hard timeout** is `status: 'skipped'` with `error: 'timeout'` | One status for both; a status of its own for Stop | Both arrive as an abort, and only `AbortSignal.reason` tells them apart (`presence/abort-reasons.ts`). The renderer has to distinguish "you stopped this" from "the group moved on without it", and the barrier has to read the second as a completed turn rather than as a stopped run — hence `aborted: false` in the result of a timeout |
| The turn creates an `AbortController` **of its own**, chained to the run's signal | Hand the run's signal to the supervisor | The run's signal is how Stop reaches every speaker at once; the supervisor has to reach exactly one. Chaining costs one listener and keeps both meanings intact |
| `runAgentTurn` never throws | Let the caller catch | Every failure has to end with a persisted terminal status and a `message.updated`, or the UI shows a cursor forever. Making that the function's own responsibility means no caller can forget |
| Reasoning is **not** fed back into later prompts | Include it like text | It is the model's scratch pad, it is not what the group heard, and replaying it inflates every later prompt |
| **Mentions are parsed here, scheduled elsewhere** | Let `ChatRunner` re-read the finished message and parse it | The finished text is already in hand at the terminal update, so parsing it there keeps **one** `message.updated` per turn instead of two, and a reply reaches the renderer with its mentions already on it. The rules that drop a self-mention, a non-member and a `[PASS]` are scheduling rules and live in `orchestration/scheduling.ts` |
| **The history is an optional parameter, not a mode flag** | A `parallel: boolean`; a second function | The turn does not need to know what a round is: either it is given a transcript or it reads one. That is the whole difference between the two speaking modes, expressed once |
| `passed` and `skipped` messages are dropped from history | Keep them with a marker | Replaying abstentions teaches the next speaker that abstaining is normal. The round bookkeeping that needs them lives in `ChatRunner` |
| The briefing exists in Chinese and English as **`.ts` files** | Locale files; one English briefing for everyone | It never reaches the renderer, so it has no i18n key; a Chinese-first model follows a Chinese prompt far more reliably. `briefing.zh-CN.ts` is the documented exception to the English-only rule |
| The briefing's `[name]:` and `@name` examples use a **real member of this chat** | A placeholder like `@name` | A model copies the example it is given |
| `'system'` is resolved from `Intl.DateTimeFormat().resolvedOptions().locale` | Ask the renderer | The prompt is assembled before any window is involved; a round trip inside a turn would be a needless dependency |

## Open questions

- Whether a `[PASS]` should be stored with its text at all, or with empty parts
  plus the status. Keeping the text makes the transcript self-explanatory in the
  database; the UI dims it either way.
- Whether the flush interval should adapt to the model's token rate rather than
  being two fixed constants.
