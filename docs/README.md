# Witena Documentation

All documentation committed to this repository is written in English. An optional
local Chinese counterpart of any document uses the `.zh.md` suffix (for example
`docs/README.zh.md`) and is gitignored.

## Directory layout

```
docs/
  PLAN.md              # The target architecture: the finished shape of the product
  STEPS.md             # The ordered checklist that gets us there, step by step
  README.md            # This file: documentation map and feature index
  features/
    _template/         # The four-document template every feature copies
      context.md
      implement.md
      frontend.md
      backend.md
    <feature>/         # One directory per feature, same four documents
```

- [PLAN.md](./PLAN.md) — the product plan: context, tech stack, data model, core
  mechanisms, UI, milestones. Read it before designing anything new. If a step
  reveals that the plan is wrong, change PLAN.md first, then write code.
- [STEPS.md](./STEPS.md) — the execution checklist. Work strictly in order, mark
  each step `[ ]` / `[~]` / `[x]`, and do not start a step before the previous
  one passes its acceptance criteria.

## The four documents per feature

Every feature keeps four documents under `docs/features/<feature>/`, updated in
the same commit as the code they describe.

| File | Contents |
|---|---|
| `context.md` | What problem this feature solves, where its boundaries are, which other features it depends on, decisions already made and trade-offs accepted |
| `implement.md` | Overall approach, data flow (user action → renderer → IPC → main → storage/model), key types and IPC contracts, known limitations and TODOs |
| `frontend.md` | Pages and components involved, zustand store fields, which IPC calls are made, interaction states (loading / streaming / error) |
| `backend.md` | Main-process modules and files, DB tables and columns, IPC handler list, how external dependencies (AI SDK / MCP SDK) are used and their pitfalls |

## Feature index

Only the features whose step is marked done in STEPS.md have their documents
written; for the rest the links point at the paths they will occupy. The step in
STEPS.md that creates each feature is listed so the order is obvious.

| Feature | One-line description | Step | Documents |
|---|---|---|---|
| `backend-client` | The `BackendClient` abstraction, shared types and typed events that keep the renderer independent of Electron IPC, plus the transport that implements them: the preload bridge, the main-process handler registry, the event bus and the application context | S1.1 `[x]`, S1.3 `[x]` | [context](./features/backend-client/context.md) · [implement](./features/backend-client/implement.md) · [frontend](./features/backend-client/frontend.md) · [backend](./features/backend-client/backend.md) |
| `database` | Infrastructure: the drizzle schema for every table, the bundled SQL migrations and the typed repositories every backend service persists through | S1.2 `[x]` | [context](./features/database/context.md) · [implement](./features/database/implement.md) · [frontend](./features/database/frontend.md) · [backend](./features/database/backend.md) |
| `i18n` | Bilingual UI infrastructure: the two locale files, i18next setup, the language setting and its persistence, and the guards that keep every string out of the components | S1.4 `[x]` | [context](./features/i18n/context.md) · [implement](./features/i18n/implement.md) · [frontend](./features/i18n/frontend.md) · [backend](./features/i18n/backend.md) |
| `ui-shell` | Navigation rail, the three page shells, the three-column dark layout from the mockup and the reusable UI primitives every later screen is built from | S1.5 `[x]` | [context](./features/ui-shell/context.md) · [implement](./features/ui-shell/implement.md) · [frontend](./features/ui-shell/frontend.md) · [backend](./features/ui-shell/backend.md) |
| `providers` | Model provider records, presets, encrypted API keys, model-list fetching, connection probing and AI SDK model construction | S1.6 `[x]` | [context](./features/providers/context.md) · [implement](./features/providers/implement.md) · [frontend](./features/providers/frontend.md) · [backend](./features/providers/backend.md) |
| `chats` | Chat CRUD, the chat list, the message stream and its rendering, message persistence | S1.7 `[x]`, S2.2 | [context](./features/chats/context.md) · [implement](./features/chats/implement.md) · [frontend](./features/chats/frontend.md) · [backend](./features/chats/backend.md) |
| `agent-turn` | One agent speaking once: system prompt assembly, the bilingual group briefing, history conversion, `streamText` streaming, usage accounting | S1.7 `[x]`, S3.1 (tools) | [context](./features/agent-turn/context.md) · [implement](./features/agent-turn/implement.md) · [frontend](./features/agent-turn/frontend.md) · [backend](./features/agent-turn/backend.md) |
| `agents` | Agent CRUD and the agent configuration page: model, parameters, system prompt, skills, MCP servers, memory | S2.1 | [context](./features/agents/context.md) · [implement](./features/agents/implement.md) · [frontend](./features/agents/frontend.md) · [backend](./features/agents/backend.md) |
| `orchestration` | `ChatRunner`: round scheduling, roundrobin / mention-only, sequential / parallel, `@` resolution, `[PASS]`, round barrier, cancellation | S1.7 `[~]` (one agent, one round, stop), S2.3 | [context](./features/orchestration/context.md) · [implement](./features/orchestration/implement.md) · [frontend](./features/orchestration/frontend.md) · [backend](./features/orchestration/backend.md) |
| `presence` | `AgentSession` and `AgentSupervisor`: heartbeat tick, stall and hard timeouts, skipping stuck agents, presence dots | S2.4 | [context](./features/presence/context.md) · [implement](./features/presence/implement.md) · [frontend](./features/presence/frontend.md) · [backend](./features/presence/backend.md) |
| `mcp` | `MCPManager`: stdio and Streamable HTTP transports, lazy connection pool, tool discovery and execution | S3.1 | [context](./features/mcp/context.md) · [implement](./features/mcp/implement.md) · [frontend](./features/mcp/frontend.md) · [backend](./features/mcp/backend.md) |
| `skills` | Scanning `userData/skills/*/SKILL.md`, frontmatter parsing and progressive disclosure via `read_skill` | S3.2 | [context](./features/skills/context.md) · [implement](./features/skills/implement.md) · [frontend](./features/skills/frontend.md) · [backend](./features/skills/backend.md) |
| `memory` | Per-agent markdown memory: `MEMORY.md` index plus `notes/`, the `memory_save` and `memory_search` tools | S3.3 | [context](./features/memory/context.md) · [implement](./features/memory/implement.md) · [frontend](./features/memory/frontend.md) · [backend](./features/memory/backend.md) |

## Starting a new feature

1. Copy `docs/features/_template/` to `docs/features/<feature>/`.
2. Fill in `context.md` before writing code — it is where the boundary and the
   decisions get pinned down.
3. Keep the other three in sync as the code lands, and add the new row to the
   table above if the feature is not already listed.
