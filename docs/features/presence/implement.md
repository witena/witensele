# presence — Implementation

## Approach

One object, `AgentSupervisor` (`src/main/presence/supervisor.ts`), created once in
`createAppContext` and reachable as `ctx.supervisor`. It holds four maps and runs
two loops, and everything it needs from the outside world arrives as an injected
function, so it imports neither electron nor the database (CLAUDE.md rule #5).

| Map | Key | Holds |
|---|---|---|
| `#sessions` | `chatId:agentId` | The live turn: message id, `AbortController`, `startedAt` |
| `#presence` | `chatId:agentId` | The last `AgentPresence` emitted for that pair |
| `#offline` | `agentId` | Why the agent is down (`timeout`, `consecutive-failures`, `probe-failed`, `manual`) |
| `#failures` | `agentId` | Consecutive `error` outcomes, across every chat |

```
                   activity                     activity
                  ┌────────┐                   ┌────────┐
                  ▼        │                   ▼        │
 available ──▶ working ────┴──▶ away ──────────┴──▶ offline
      ▲      beginTurn   idle >      idle >          │
      │                  stall       hard →          │
      └──────────────────────────────abort + skip ───┘
                        endTurn / successful probe
```

The **heartbeat** (`tick()`, every 1 s) walks `#sessions`, asks `getTimeouts(chatId)`
for that chat's budgets and applies the two rules, hard timeout first. The
**recovery loop** (`probeOffline()`, every 60 s) probes every agent in `#offline`.
Both intervals come from the injected `SupervisorClock`, whose real implementation
`unref()`s its timers so a heartbeat can never keep a Node process — or a vitest
run — alive.

`runAgentTurn` is the only caller of `beginTurn` / `activity` / `endTurn`. It
creates an `AbortController` **of its own**, chained to the run's signal, and hands
that one to `streamText` and to the supervisor: the run's signal is how Stop
reaches every speaker of a round at once, and the turn's own controller is how the
supervisor reaches exactly one. Which of the two fired is read back from
`AbortSignal.reason` through `isTimeoutAbort` (`presence/abort-reasons.ts`).

`ChatRunner` consults `supervisor.isOffline(agentId)` at every round boundary,
after the plan is computed — so an `@mention` of an offline member still resolves,
and the reason nobody answered becomes the `allOffline` notice rather than silence.

## Data flow

**A turn that answers normally**

```
ChatRunner → runAgentTurn
  → messages.create (streaming) → message.created
  → supervisor.beginTurn        → presence.changed { working }
  → streamText → for each part: supervisor.activity  (no event: no state change)
  → messages.update (done)      → message.updated
  → supervisor.endTurn(done)    → presence.changed { available }
```

**A turn that stalls**

```
supervisor.tick()  idle > stallTimeoutMs → presence.changed { away }
supervisor.tick()  idle > hardTimeoutMs
  → controller.abort(new TimeoutAbortReason(...))
  → markOffline(agentId, 'timeout') → presence.changed { offline } per chat
runAgentTurn's stream rejects with that reason
  → isTimeoutAbort → status 'skipped', error 'timeout'
  → messages.update             → message.updated
  → messages.create (notice)    → message.created  { key: 'agentSkipped' }
  → supervisor.endTurn(skipped) → (offline is left alone)
ChatRunner's allSettled releases; the round finishes with the answers it has
```

**Recovery**

```
member panel Retry → presence.retry → supervisor.retry
  → probeProvider(agentId) = resolveProvider + fetchModels
  → true  → markAvailable → presence.changed { available } per chat
  → false → markOffline('probe-failed')
resolves with the presence, which the store also applies
```

**Seeding the renderer**

```
chat selected → stores/presence.load → presence.list → supervisor.list(chatId)
  → one AgentPresence per member (members with no session are `available`,
    unless the agent is offline globally)
```

## Key types and contracts

`AgentPresence`, `PresenceState`, `AppTimeouts` and `ChatSettings.stallTimeoutMs` /
`hardTimeoutMs` were all declared in S1.1 and are unchanged. What S2.4 adds:

| Channel / method | Request | Response | Notes |
|---|---|---|---|
| `presence.list` | `{ chatId }` | `AgentPresence[]` | Member order. `not_found` for an unknown chat |
| `presence.retry` | `{ chatId, agentId }` | `AgentPresence` | Probes once. A failed probe is a *value*, not a rejection |

| Event | Payload | Emitted when |
|---|---|---|
| `presence.changed` | `{ presence: AgentPresence }` | Any state change of a (chat, agent) pair: `beginTurn`, the two timeouts, `endTurn`, `markOffline` / `markAvailable` (one per chat the agent is in) |

Main-process types worth knowing:

| Type | Where | Meaning |
|---|---|---|
| `TurnOutcome` | `presence/supervisor.ts` | `done \| passed \| error \| aborted \| skipped` — what `endTurn` is told |
| `PresenceTimeouts` | `presence/supervisor.ts` | `{ stallTimeoutMs, hardTimeoutMs }`, already resolved for one chat |
| `SupervisorClock` | `presence/supervisor.ts` | `{ now, setInterval, clearInterval }`; `realClock` is the default |
| `TimeoutAbortReason` | `presence/abort-reasons.ts` | The abort reason that means "hard timeout"; `isTimeoutAbort` recognises it by shape as well as by `instanceof` |
| `SupervisorOverrides` | `app-context.ts` | Clock, intervals and probe, the only parts a caller may replace |

## Tests

| File | Covers |
|---|---|
| `src/main/presence/supervisor.test.ts` | The whole state machine on a fake clock: working → away at the stall budget, → offline plus `controller.abort` with a timeout reason at the hard one, activity clearing `away` and never letting it happen, three consecutive errors, the counter reset, probe success and failure, `retry`, `list` for members that never spoke, the per-chat override beating the global setting, the fan-out over several chats, and `stop()` |
| `src/main/orchestration/chat-runner.test.ts` (`ChatRunner + AgentSupervisor`) | Mock models, 50 ms / 120 ms budgets and a 10 ms heartbeat: a stream that never emits goes `working → away → offline`, its message ends `skipped` / `timeout`, the `agentSkipped` notice names the member, the other speaker still finishes `done`, `run.finished` is `completed`, the next round excludes the offline member, `allOffline` when nobody is left, `presence.retry` with a succeeding probe puts it back, and `presence.list` answers for every member |
| `src/renderer/src/stores/presence.test.ts` | Seeding from `presence.list`, a later event overriding the seed, other chats surviving a seed, the retry action and its pending flag, and `chat.deleted` dropping only that chat |
| `src/shared/contracts.test.ts` | `presence.list` / `presence.retry` are in `BACKEND_METHODS` and in the namespace list |
| `src/main/handlers/handlers.test.ts` | Both methods are implemented rather than stubs |
| `e2e/presence.spec.ts` | The real thing: a provider pointing at a non-routable address goes orange then grey, its message is `skipped`, the notice appears, the member on Ollama answers `done`, the run finishes, and Retry against the same dead endpoint leaves it offline. Captures `test-results/shots/presence.png` |

## Known limitations and TODOs

- `toolTimeoutMs` is read from S3.1: `runAgentTurn` passes it to every
  `McpManager.callTool`, which hands it to the MCP SDK's `RequestOptions.timeout`
  so the request is cancelled rather than merely abandoned.
- The probe interval is fixed at 60 s with no back-off, so an agent that has been
  offline for an hour is still probed every minute.
- `probeOffline()` probes every offline agent in parallel; with many dead
  providers that is a burst of requests every minute. Nothing in the MVP has
  enough agents for it to matter.
- A turn that is skipped leaves its partial text in the message. That is
  deliberate — the tokens were paid for — but it means a `skipped` message is not
  always empty.
- The supervisor holds one session per (chat, agent), so the same agent speaking
  twice in one chat at the same time is not representable. Nothing schedules that.
