# agent-turn — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/main/agents/agent-turn.ts` | `runAgentTurn`: the message row, `streamText`, the deltas, the flush, the terminal status, the usage, the presence pair |
| `src/main/agents/history.ts` | `toModelMessages`: the shared transcript → one agent's `ModelMessage[]` |
| `src/main/agents/briefing.ts` | `buildGroupBriefing` (picks the language) and `resolveMainLanguage` |
| `src/main/agents/briefing.en.ts` | The English wording |
| `src/main/agents/briefing.zh-CN.ts` | The Chinese wording. **The only `.ts` file in the repository that may contain Chinese** — see below |
| `src/main/agents/default-agent.ts` | `ensureDefaultAgent`, documented under [`chats`](../chats/backend.md) |

None of them imports electron. `agent-turn.ts` reaches the outside world only
through `ctx.repos`, `ctx.events` and the injected model factory.

## Database

No migration. It writes one `messages` row per turn:

| Column | Written | When |
|---|---|---|
| `parts` | `[]`, then the accumulated parts | On create, on every flush, and once at the end |
| `status` | `streaming`, then `done` \| `passed` \| `error` | Create, then the terminal update |
| `round` | The round the runner passed | On create |
| `in_reply_to` | The `inReplyTo` the runner passed, when it is not empty | On create |
| `mentions` | `[]`, then the ids parsed out of the finished text (empty for a `[PASS]`) | Create, then the terminal update |
| `usage` | `Usage` mapped from the `finish` part | Terminal update, when the provider reported any |
| `error` | `'aborted'` or the provider's message | Terminal update, on the failure paths |

Flush policy: `messages.update({ parts })` every `FLUSH_INTERVAL_MS` (500) or
`FLUSH_EVERY_DELTAS` (40), whichever comes first, so a crash keeps most of an
answer without paying a write per token.

## IPC handlers

None. This feature is called by `ChatRunner`, never by the transport.

## Events emitted

| Event | Payload | Emitted when |
|---|---|---|
| `message.created` | `{ message }` | The empty `streaming` row is inserted, before the request goes out |
| `message.delta` | `{ chatId, messageId, delta: { kind, text } }` | Once per `text-delta` / `reasoning-delta` |
| `message.updated` | `{ message }` | The terminal status is persisted — on every path |
| `presence.changed` | `{ presence }` | `working` at the start, `available` at the end |

## External dependencies

### AI SDK v7 — the exact names used, verified against the installed types

Read from `node_modules/ai/dist/index.d.ts` (ai **7.0.99**) and
`node_modules/@ai-sdk/provider/dist/index.d.ts`, not from memory. This extends the
table in [`../providers/backend.md`](../providers/backend.md), which covers the
four provider factories and `generateText`.

| Name | Package | Shape used here |
|---|---|---|
| `streamText` | `ai` | `streamText({ model, system, messages, abortSignal, maxOutputTokens?, temperature?, onError })` |
| `StreamTextResult.fullStream` | `ai` | An async iterable of `TextStreamPart`, iterated with `for await` |
| `TextStreamTextDeltaPart` | `ai` | `{ type: 'text-delta', id, text }` |
| `TextStreamReasoningDeltaPart` | `ai` | `{ type: 'reasoning-delta', id, text }` |
| `TextStreamFinishPart` | `ai` | `{ type: 'finish', finishReason, rawFinishReason, totalUsage }` |
| `TextStreamAbortPart` | `ai` | `{ type: 'abort', reason? }` |
| `TextStreamErrorPart` | `ai` | `{ type: 'error', error: unknown }` |
| `LanguageModelUsage` | `ai` | `{ inputTokens, outputTokens, totalTokens, inputTokenDetails, outputTokenDetails }` — every number is `number \| undefined` |
| `ModelMessage` | `ai` (re-exported from `@ai-sdk/provider-utils`) | `SystemModelMessage \| UserModelMessage \| AssistantModelMessage \| ToolModelMessage`; the first two fields are `role` and `content` |
| `MockLanguageModelV4` | `ai/test` | `new MockLanguageModelV4({ provider, modelId, doStream })`, plus `doStreamCalls` for asserting what was sent |
| `simulateReadableStream` | `ai/test` | `({ chunks, initialDelayInMs, chunkDelayInMs })`, used to pace a mock stream so an abort can land mid-answer |

Pitfalls, each one hit while writing this step:

- **`text-delta` carries `text` at the `ai` level and `delta` at the provider
  level.** `TextStreamPart` (what `fullStream` yields) has `text`;
  `LanguageModelV4StreamPart` (what a mock's `doStream` must produce) has
  `delta`. Writing a mock from the `fullStream` shape produces a stream that type
  checks nowhere and streams nothing.
- **The V4 usage in a mock is nested**: `{ inputTokens: { total, noCache,
  cacheRead, cacheWrite }, outputTokens: { total, text, reasoning } }`, and
  `finishReason` is `{ unified, raw }`. The `ai`-level `LanguageModelUsage` that
  reaches `finish.totalUsage` is the flat one, with `undefined` allowed
  everywhere — hence `toUsage`, which fills a missing total from the two halves
  rather than producing `NaN`.
- **`streamText` does not throw for provider errors.** They arrive as an `error`
  part in `fullStream`, and the SDK's default `onError` logs them itself; this
  code passes a no-op `onError` so the same failure is not reported twice, and
  reads the part instead.
- **An abort arrives two ways.** Some providers surface it as an `abort` part,
  others by rejecting the iteration. Both are handled, and `signal.aborted` is
  re-checked after the loop, because an abort that lands between the last chunk
  and the `finish` part must not be recorded as a successful turn.
- **A stream part union grows.** The `switch` has a `default: break`, so a new
  part type (tool input deltas, sources, files) is ignored rather than crashing a
  turn — S3.1 adds the cases it needs.
- **`fullStream` must be fully consumed.** Abandoning it mid-iteration leaves the
  request open; the loop always runs to completion or to an abort.
- `maxOutputTokens` and `temperature` are spread in only when the agent sets
  them, because `exactOptionalPropertyTypes` forbids passing an explicit
  `undefined`.

### The group briefing, and why Chinese lives in a `.ts` file

CLAUDE.md rule #1 keeps every committed file English and confines product Chinese
to `src/renderer/src/locales/zh-CN.json`. `src/main/agents/briefing.zh-CN.ts` is
the **one documented exception**, for a reason that is worth stating precisely:

- It is neither source prose nor UI copy. It is a **prompt sent to a model**, and
  a Chinese-first model follows a Chinese instruction far more reliably than an
  English one it has to translate first (PLAN, "Bilingual UI").
- It cannot be a locale entry, because locale files are the renderer's and are
  translated at display time. Nothing here ever reaches the renderer, so it has
  no key and no English counterpart in `en.json`.

Anything that scans the repository for CJK must exclude exactly that file, plus
`zh-CN.json`.

Language selection: `resolveMainLanguage(settings.language)` passes `zh-CN` and
`en` through and resolves `'system'` from
`Intl.DateTimeFormat().resolvedOptions().locale` — the backend has no
`navigator`, and a renderer round trip inside a turn would be a needless
dependency. Anything that is not a Chinese locale resolves to English, matching
the renderer's own rule.
