# presence — Context

> **Status: implemented (S2.4).** `AgentSupervisor`, the one-second heartbeat, the
> stall and hard timeouts, the `skipped` outcome and its notice, provider probing,
> manual retry, and the presence dots in the member panel and on message avatars.

## Problem

A group chat waits for everybody. If one member's provider accepts the request and
then goes silent — a queue that never drains, a key that was revoked mid-stream, a
laptop that lost its network — every other member's answer is stuck behind it and
the user is looking at a spinner with no way to tell "thinking hard" from "dead".

Presence is the answer to *what is each agent doing right now*, and the two
timeouts are the answer to *when do we stop waiting*. The four states follow the
Teams convention because they are the colours everybody already reads without a
legend: green idle, red busy, orange stalled, grey gone.

## Scope

- **`AgentSession`**: one live turn of one (chat, agent) pair — the message it is
  writing into, its `AbortController`, and the timestamp of its last sign of life.
- **`AgentSupervisor`** on the `AppContext`: the session map, the four states, a
  heartbeat every `HEARTBEAT_INTERVAL_MS` (1 s) and a recovery loop every
  `PROBE_INTERVAL_MS` (60 s).
- **The two timeouts**, resolved per chat: `stallTimeoutMs` → `away` (a colour,
  nothing is interrupted); `hardTimeoutMs` → abort that turn, message `skipped`,
  agent `offline`, `agentSkipped` notice, round continues.
- **Offline as a property of the agent**, not of one chat: `MAX_CONSECUTIVE_FAILURES`
  (3) errors in a row, a hard timeout, or a failed probe take it offline
  everywhere, and `ChatRunner` stops scheduling it.
- **Recovery**: a periodic model-list probe of offline agents, plus the manual
  "Retry" button in the member panel (`presence.retry`).
- **The dots**: `presence.list` seeds the renderer when a chat is opened,
  `presence.changed` keeps it current, and both the member panel and every message
  avatar read the same store.
- **Settings → Timeouts & heartbeat**: the three global budgets and the colour
  legend. The per-chat *hard* timeout override stays in the group settings block.

## Out of scope

| Not here | Owned by |
|---|---|
| Who speaks and when, the round barrier, `run.finished` reasons | [`orchestration`](../orchestration/context.md) |
| Streaming one turn, prompt assembly, the terminal message status | [`agent-turn`](../agent-turn/context.md) |
| Building a model client, reading `/models`, "Test connection" | [`providers`](../providers/context.md) |
| `toolTimeoutMs` actually capping a tool call | `mcp` (S3.1 `[x]`) — `agent-turn` reads the setting and passes it to `McpManager.callTool`, which hands it to the MCP SDK's `RequestOptions.timeout` |
| Per-agent token usage in the member panel | S4.1 |
| Persisting presence across restarts | Nobody. Presence is a fact about *now*; see the decisions below |

## Dependencies

| Feature | What this one needs from it |
|---|---|
| [`agent-turn`](../agent-turn/context.md) | Calls `beginTurn` / `activity` / `endTurn`, and owns the per-turn `AbortController` the supervisor aborts |
| [`orchestration`](../orchestration/context.md) | Consults `isOffline` at every round boundary; its `allSettled` barrier is what lets a skipped turn release the round |
| [`providers`](../providers/context.md) | `resolveProvider` + `fetchModels` are the recovery probe |
| [`chats`](../chats/context.md) | `ChatSettings.stallTimeoutMs` / `hardTimeoutMs` overrides, and the member list `presence.list` answers for |
| [`i18n`](../i18n/context.md) | `presence.*` labels, `notices.agentSkipped` / `notices.allOffline`, `settings.timeouts.*` |

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| **`away` never interrupts anything** | Abort at the stall timeout; retry the request | A provider that queues for forty seconds and then answers is working, not broken. The colour is there so the user can tell the difference; acting on it would throw away answers that were about to arrive |
| **The hard timeout aborts one turn, not the run** | Abort the whole round; let the round wait | The barrier exists so nobody speaks while others are still answering — one dead provider must not turn that into one dead chat. `runAgentTurn` chains a controller of its own to the run's signal precisely so the supervisor can reach a single speaker |
| **A timed-out turn is `skipped`, not `error`** | Reuse `error` with a detail | The renderer has to tell "you stopped this" from "the model died" from "the group moved on without it", and `MessageStatus` already reserved `skipped` for exactly this. It also reports `aborted: false`, so the barrier does not read a skip as the user pressing Stop |
| **The supervisor never imports the database** | Give it `ctx` like `ChatRunner` has | Timeouts, membership and the probe arrive as four injected accessors, so the whole state machine is exercised in `supervisor.test.ts` with no storage, no network and a clock the test advances by hand — a 120 s timeout asserted in a millisecond |
| **Time is injected** (`SupervisorClock`) | `vi.useFakeTimers()` around the real supervisor | Fake timers would also have to fake the AI SDK's stream scheduling in the integration tests. An injected clock keeps the unit tests instant *and* lets the integration test run on the real clock with a 10 ms heartbeat |
| **`offline` is per agent, fanned out per chat** | Per (chat, agent) only | A provider that is down is down in every chat. The presence *records* stay per (chat, agent) because that is what `AgentPresence` declares and what a member panel renders, so `markOffline` writes one record per chat the agent is in |
| **Three consecutive errors take an agent offline**, `done` / `passed` reset the counter | Offline on the first error; never on errors | One 500 is noise; three in a row is a provider. Counting across chats is deliberate — it is the *provider* that is failing, not the conversation |
| **The recovery probe is `fetchModels`, never a generation** | `providers.testConnection` (which runs `generateText`) | A loop that runs every minute must be free and must not depend on a model being loaded. "Does the endpoint talk to us" is the only question that matters for coming back online |
| **Presence is never persisted** | Store the last state per agent | A green dot restored at startup for a provider that died overnight is worse than no dot. Everything starts at `available` and the first turn (or the first probe) corrects it |
| **The stall timeout has no per-chat control in the UI** | Add a second select to the group settings | PLAN puts the per-chat override on the hard timeout only; the stall budget is a global preference about how twitchy the orange dot is. The field exists in `ChatSettings` and the backend honours it, so a future control is a UI change alone |
| **"Away · 12s" is counted in the renderer** | Send the elapsed time with the event | The number changes every second and the backend emits only on a state *change*. One event per transition instead of one per second per agent, and the ticking timer only exists while a member is actually away |

## Open questions

- Whether an agent that recovers should be re-invited to the round it was skipped
  from. Today it simply speaks in the next round.
- Whether `offline` should survive an app restart within a few minutes, so a
  provider that is known to be down is not asked again immediately on launch.
- Whether the probe interval should back off (1 min, 5 min, 15 min) for an agent
  that has been offline for a long time.
