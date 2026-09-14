# agent-turn — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/main/agents/agent-turn.ts` | `runAgentTurn`: the message row, the per-turn `AbortController`, `streamText`, the deltas, the flush, the terminal status, the usage, and the supervisor calls around all of it. From S3.1 also `collectAgentTools` (which enforces the side-effects rule), the tool loop and `looksLikeToolRejection`; from S3.2 `enabledSkills` and the prompt sections; from S5.4 `executorWorkdir`, the executor branch of `collectAgentTools` and the permission wrapper around a `sideEffects` MCP call; from S5.5 `diffPartsFrom`, which appends one `DiffPart` per written file when the stream ends; from S5.11 `workspaceWorkdir` (the read-only rule), `buildTurnPrompt` (the prompt plus `materialsOmitted`) and the read-only branch of `collectAgentTools`; and from S5.12 `TurnStage` (the `handoff` intent and `reviewing`) and `deliveredRef`, which appends the deliverable's `FileRefPart` after the diffs; from S5.14 `showsThinking`, which decides whether a `reasoning-delta` is kept at all, and `closing` on `TurnStage` |
| `src/main/agents/history.ts` | `toModelMessages`: the shared transcript → one agent's `ModelMessage[]`. From S4.2 it also caps each replayed `tool-result` at `MAX_TOOL_RESULT_CHARS` (4 KB) and strips a trailing marker from a reply that had real content — `[PASS]` since S4.3, `[AGREED]` and `[CONTINUE]` since S5.14, all through the same `stripTrailingMarkers` |
| `src/main/agents/context-budget.ts` | `estimateTokens` and `fitHistory`: the character-count estimate and the drop-oldest-first budget (S4.2). Pure; no database, no `AppContext` |
| `src/main/agents/materials.ts` | `buildMaterialsSection`: the goal's materials as a prompt section, inside a quarter of the model's window, with the rest named by path (S5.11). Reads the files it is pointed at through `executor/paths.ts`; no database, no `AppContext` |
| `src/main/agents/title.ts` | `sanitizeTitle`, `fallbackTitle` and `generateChatTitle` — the automatic chat title (S4.3). `ChatRunner` is what calls it; see [`orchestration`](../orchestration/backend.md) |
| `src/shared/markers.ts` | `PASS_TOKEN`, `AGREED_TOKEN`, `CONTINUE_TOKEN`, `isPassOnly`, `closureMarker` and `stripTrailingMarkers`: shared, because the status decision here, the scheduling decision in `orchestration` and the rendering in the transcript have to read the identical rule. It was `src/shared/pass.ts` until S5.14, when the second pair of markers made the name wrong; every import was updated rather than aliased |
| `src/main/agents/briefing.ts` | `buildGroupBriefing` (picks the language) and `resolveMainLanguage` |
| `src/main/agents/briefing.en.ts` | The English wording, including the conditional `memory_save` rule (S3.3), the `Goal of this chat` section (S5.10), the `[AGREED]` / `[CONTINUE]` rule and the `This is the closing turn` block (S5.14) |
| `src/main/agents/briefing.zh-CN.ts` | The Chinese wording, same rules in the same order. **The only `.ts` file in the repository that may contain Chinese** — see below |
| `src/main/agents/default-agent.ts` | `ensureDefaultAgent`, documented under [`chats`](../chats/backend.md) |

None of them imports electron. `agent-turn.ts` reaches the outside world only
through `ctx.repos`, `ctx.events`, `ctx.mcp`, `ctx.memory`, `ctx.permissions`,
`ctx.userDataDir` and the injected model factory — all of them injected, which is
what lets a turn with skills, memory and an executor's tools be driven from
vitest against a temporary directory.

The prompt sections and the built-in tools themselves live with their features:
`skills/tools.ts` ([`../skills/backend.md`](../skills/backend.md)),
`memory/tools.ts` ([`../memory/backend.md`](../memory/backend.md)) and
`executor/tools.ts` ([`../executor/backend.md`](../executor/backend.md)). This
file decides the **order** of the sections and **which** tools an agent gets.

`buildTurnPrompt(ctx, chat, agent, members, stage?)` is the assembler since
S5.11 and returns `{ text, materialsOmitted }`; `buildSystemPrompt` is its
`text`, which is what every caller that only wants the prompt uses. It takes the
chat since S5.4, because the executor section names the folder — and since S5.10 for a
second reason: `chat.goal` reaches `buildGroupBriefing`, so **every** member is
briefed with what the chat is for, executor or not.

`stage` is S5.12's shape for what used to be a bare `handoff` boolean, and it
carries the two things a *round* can be:

| Field | Set by | Effect on the prompt |
|---|---|---|
| `handoff: HandoffIntent \| null` | `ChatRunner`, for the executor of the implement round only | `buildExecutorSection` appends `HANDOFF_BRIEFING` or `DELIVER_BRIEFING`, plus `goalHandoffLine` |
| `reviewing: boolean` | `ChatRunner`, for every speaker of the review round | `buildGroupBriefing` appends the review block, after the goal |
| `readGit` | The tests | Replaces the one `gitInfo` probe (see below) |

`collectAgentTools(ctx, chat, agent, { signal, toolTimeoutMs, members })` takes
the member list for the same reason the prompt does: it is how the chat's
executor is picked deterministically. Since S5.10 `buildExecutorSection` takes
the goal as well, and appends `goalHandoffLine` to the hand-off suffix — the
deliverable to write, or the change to make, and since S5.12 the branch it is
being made on.

That branch is why `buildTurnPrompt` runs `gitInfo` itself, once, and hands the
result to **both** the executor section and `buildWorkspaceSection`. Two probes
for one prompt would be two `spawnSync` calls on a large repository and a chance
for the two halves of the same prompt to name two different branches.

S5.11 adds the second attachment rule, `workspaceWorkdir(chat)`, which asks only
whether the chat has a folder: an agent that is not the chat's executor gets the
four tools in `READ_ONLY_EXECUTOR_TOOLS` and the `Workspace` section, and never
anything that writes. Both sections it adds — `Workspace` between the executor
section and the skills, `Materials` last — are built inside `buildTurnPrompt`, so
the prompt and the tool set are decided by the same two functions and cannot
disagree.

## Database

No migration. It writes one `messages` row per turn:

| Column | Written | When |
|---|---|---|
| `parts` | `[]`, then the accumulated parts — text, reasoning **when this agent shows its thinking** (S5.14), and from S3.1 `tool-call` / `tool-result` | On create, on every flush, once per tool part, and once at the end |
| `status` | `streaming`, then `done` \| `passed` \| `error` | Create, then the terminal update |
| `round` | The round the runner passed | On create |
| `in_reply_to` | The `inReplyTo` the runner passed, when it is not empty | On create |
| `mentions` | `[]`, then the ids parsed out of the finished text (empty for a `[PASS]`) | Create, then the terminal update |
| `usage` | `Usage` mapped from the `finish` part, whose `totalUsage` is already the **sum over every step** of a tool loop | Terminal update, when the provider reported any |
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
| `message.delta` | `{ chatId, messageId, delta: { kind, text } }` | Once per `text-delta`, and once per `reasoning-delta` **only when `showsThinking(ctx, agent)` is true** (S5.14). A hidden reasoning delta is neither emitted nor stored; it still reaches `ctx.supervisor.activity`, because the model really is working |
| `message.updated` | `{ message }` | The terminal status is persisted — on every path |
| `presence.changed` | `{ presence }` | Emitted by `AgentSupervisor`, which the turn drives: `beginTurn` → `working`, `endTurn` → `available` (or `offline`). Every stream part is reported as `activity`, which emits only when it clears `away` |
| `message.delta` | `{ delta: { kind: 'part', part } }` | A `tool-call` or `tool-result` part was appended (S3.1) |
| `message.created` | the `agentSkipped` notice | The turn ended on the supervisor's hard timeout |
| `message.created` | the `toolsUnsupported` notice | The provider rejected the tools and the turn was retried without them — once per chat per agent (S3.1) |
| `permission.requested` / `permission.resolved` | see [`executor`](../executor/backend.md) | A gated tool suspends inside a turn and is released. Emitted by `ctx.permissions`, not by this file, but they are part of a turn's observable event stream |
| `message.delta` with a `diff` part | `{ chatId, messageId, delta: { kind: 'part', part } }` | After the stream ends, one per file the turn wrote (S5.5). The rules — only the write tools, only successful calls, grouped by path in call order — are in [`executor`](../executor/backend.md), "Diff parts" |

## External dependencies

### AI SDK v7 — the exact names used, verified against the installed types

Read from `node_modules/ai/dist/index.d.ts` (ai **7.0.99**) and
`node_modules/@ai-sdk/provider/dist/index.d.ts`, not from memory. This extends the
table in [`../providers/backend.md`](../providers/backend.md), which covers the
four provider factories and `generateText`. The **tool** half of the SDK —
`tool`, `jsonSchema`, `stepCountIs`, and the three tool stream parts — is
documented in [`../mcp/backend.md`](../mcp/backend.md), where it is used.

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
  turn. S3.1 added `tool-call`, `tool-result` and `tool-error`; the `tool-input-*`
  streaming cases are still deliberately ignored, because the card only appears
  once the arguments are complete.
- **`fullStream` must be fully consumed.** Abandoning it mid-iteration leaves the
  request open; the loop always runs to completion or to an abort.
- `maxOutputTokens` and `temperature` are spread in only when the agent sets
  them, because `exactOptionalPropertyTypes` forbids passing an explicit
  `undefined`. Since S5.9 the agent form no longer writes either, so the common
  case is that **neither** option reaches the call and the provider's own
  defaults decide the sampling; an agent saved before S5.9 still carries its
  values and they still reach `streamText` unchanged.

### Whether a turn keeps its thinking (S5.14)

```ts
export function showsThinking(ctx: AppContext, agent: Agent): boolean {
  if (agent.params.reasoning !== undefined) return agent.params.reasoning
  try {
    return showsThinkingByDefault(ctx.repos.providers.get(agent.providerId, ctx.userId))
  } catch {
    return false
  }
}
```

Read once per turn, before the stream. Three things about it are decisions:

- **`undefined` is not `false`.** It means the agent has no choice stored — every
  record written before S5.14, and any future API caller that omits the field —
  and the provider answers instead, by exactly the rule `agents.create` writes
  into a new agent's `params` (`showsThinkingByDefault` in `@shared/presets`:
  false for a local or `openai-compatible` provider, true for `anthropic`,
  `openai` and `google`). One rule in one place, applied at two moments.
- **A missing provider answers `false`.** The turn is about to fail on it anyway,
  and hiding is the half of the choice that cannot fill a transcript with
  something nobody asked for.
- **Nothing about the request changes.** No provider option was ever derived from
  this field and none is now; the model thinks exactly as much as it would have.
  What changes is one `case` in the `fullStream` switch.

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
