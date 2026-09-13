# presence — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/main/presence/supervisor.ts` | `AgentSupervisor`: the session map, the four states, `tick()`, the probe loop, `markOffline` / `markAvailable`, `probe` / `retry`. Also `HEARTBEAT_INTERVAL_MS`, `PROBE_INTERVAL_MS`, `MAX_CONSECUTIVE_FAILURES`, `realClock` |
| `src/main/presence/abort-reasons.ts` | `TimeoutAbortReason`, `isTimeoutAbort`, `TIMEOUT_ERROR` — how a hard timeout is told apart from a user Stop |
| `src/main/app-context.ts` | `createSupervisor` builds the four accessors from the context; `resolveTimeouts` merges the chat's overrides over `AppSettings.timeouts`; `probeAgentProvider` is the model-list probe. `ctx.close()` stops the loops |
| `src/main/agents/agent-turn.ts` | Chains a per-turn `AbortController` to the run's signal and calls `beginTurn` / `activity` / `endTurn`; turns a timeout abort into `skipped` / `'timeout'` and writes the `agentSkipped` notice |
| `src/main/orchestration/chat-runner.ts` | Filters offline agents out of every round's speakers; writes `allOffline` when that leaves nobody |
| `src/main/handlers/presence.ts` | The two handlers |
| `src/main/testing.ts` | The test context builds a supervisor whose probe answers `false` unless the test says otherwise |

No electron anywhere in this list (CLAUDE.md rule #5). The supervisor does not
even reach the database: it takes `getTimeouts`, `listChatIdsForAgent`,
`listAgentIdsForChat`, `probeProvider` and `emit` as constructor arguments.

## Database

Presence writes nothing and has no table. It **reads** two things, and only
through injected accessors:

| Table | Column | Type | Notes |
|---|---|---|---|
| `settings` | `data.timeouts` | json (`AppTimeouts`) | The global budgets, under `DEFAULT_APP_SETTINGS.timeouts` |
| `chats` | `settings.stallTimeoutMs` / `hardTimeoutMs` | json, optional | Per-chat overrides; absent means "use the global value" |
| `chat_members` | `chatId`, `agentId` | — | `presence.list` and the fan-out of a global offline mark |

Migrations: none. Every field already existed (S1.2, S2.2); `MessageStatus`
already had `skipped`.

## IPC handlers

| Channel | Input | Output | Errors |
|---|---|---|---|
| `presence.list` | `{ chatId: string }` | `AgentPresence[]`, in member order | `validation` for a missing or empty `chatId`; `not_found` for a chat that does not exist or belongs to another user |
| `presence.retry` | `{ chatId: string; agentId: string }` | the `AgentPresence` the probe produced | `validation` for a missing id; `not_found` for an unknown chat or agent. A **failed probe is not an error** — it resolves with the unchanged `offline` presence |

`settings.update` already accepted `timeouts` and merges it field by field in
`SettingsRepository.update`; S2.4 adds the UI that uses it and a test for the
partial merge.

## Events emitted

| Event | Payload | Emitted when |
|---|---|---|
| `presence.changed` | `{ presence: AgentPresence }` | `beginTurn` (`working`); `tick` (`away`, `offline`); `activity` only when it clears `away`; `endTurn` (`available`, or nothing when the agent stays offline); `markOffline` / `markAvailable`, once per chat the agent is a member of |
| `message.created` | the `agentSkipped` system message | A turn ended on the hard timeout (emitted by `runAgentTurn`) |
| `message.created` | the `allOffline` system message | A round had speakers but every one of them was offline (emitted by `ChatRunner`) |

A delta-by-delta `activity()` emits **nothing**: one IPC message per token would
be the most expensive thing in the process, and the state has not changed.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `ai` (`streamText`) | Receives the turn's own `abortSignal`; the provider forwards it to `fetch`, which is what actually kills a hanging request | The abort surfaces two different ways depending on the provider — as an `abort` part on `fullStream` or as a rejection — so both paths have to reach the same terminal state. `AbortSignal.reason` is the only thing that survives intact, hence `TimeoutAbortReason` rather than a message string |
| `ai` retries | — | `streamText` retries a failed request twice with exponential backoff by default. A provider that fails *fast* therefore still takes several seconds to give up, which can race a short hard timeout. It does not affect a provider that hangs, which is the case this feature is about |
| `@ai-sdk/openai-compatible` via `providers/discovery.fetchModels` | The recovery probe | `FETCH_MODELS_TIMEOUT_MS` (10 s) bounds it, so a dead endpoint cannot hold the probe loop open |
| Node timers | The two loops | `setInterval` keeps the event loop alive, which turns "the test suite finished" into "the test suite hangs". `realClock` calls `unref()` on every handle it creates; Electron's main process is kept alive by its windows, so nothing is lost |
| `undici` (Node's `fetch`) | Only indirectly, in the end-to-end spec | Ports on the WHATWG **bad-port list** (9, 11, 13, …) are rejected in milliseconds with `bad port` instead of hanging, so a "black hole" endpoint for testing must use a port outside that list. Connecting to an unroutable host otherwise hangs for undici's own ~10 s connect timeout |
