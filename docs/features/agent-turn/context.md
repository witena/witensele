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
  usage, and the `presence.changed` pair around the turn.

## Out of scope

| Not here | Owned by |
|---|---|
| Who speaks and when | `orchestration` |
| Scanning a reply for `@name` to schedule the next round | `orchestration` (S2.3) |
| Tools: MCP, `read_skill`, `memory_*`, and the `stopWhen` loop around them | `mcp` (S3.1), `skills` (S3.2), `memory` (S3.3) |
| Heartbeat, stall / hard timeouts, `skipped`, the real presence state machine | `presence` (S2.4) |
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
| An aborted turn is `status: 'error'` with `error: 'aborted'` | A new `MessageStatus`; `skipped` | `skipped` is reserved for the supervisor's hard timeout (S2.4), and the renderer has to tell "you stopped this" from "the model died". S2.3 may refine it |
| `runAgentTurn` never throws | Let the caller catch | Every failure has to end with a persisted terminal status and a `message.updated`, or the UI shows a cursor forever. Making that the function's own responsibility means no caller can forget |
| Reasoning is **not** fed back into later prompts | Include it like text | It is the model's scratch pad, it is not what the group heard, and replaying it inflates every later prompt |
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
