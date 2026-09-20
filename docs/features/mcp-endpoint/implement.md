# mcp-endpoint — Implementation

> Not built yet. The design is PLAN.md "Witena as an MCP server (the MCP
> endpoint)"; the types every package codes against are under "Frozen contracts"
> in [`tasks.md`](./tasks.md). Each work package replaces part of this file with
> what it actually built.

## Approach

Three pieces, none of which owns business logic:

| Piece | Where | Owns |
|---|---|---|
| Contracts | `src/shared/mcp-tools.ts`, `src/shared/mcp-discovery.ts` | Tool names, zod inputs, the result type, the discovery file's schema and path |
| Endpoint | `src/main/mcp-endpoint/` | Guards, the MCP transport, the tools over `HandlerMap`, the discussion watcher over `EventBus`, the listening host and its discovery file |
| Shim | `src/mcp-shim/` → `out/mcp-shim/witena-mcp.cjs` | stdio, offline `tools/list`, discovery, lazy launch, forwarding |

## Data flow

IDE agent → `tools/call` on stdio → shim → (launch the app if needed) → Streamable
HTTP `POST /mcp` with the bearer token → guards → tool → `watchDiscussion`
subscribes → `handlers['chat.send']` → `ChatRunner` runs as for any message →
`run.finished` → `readDiscussion` → `DiscussionResult` → tool result → shim → IDE.
The window, if open, sees the same events on the same bus.

## Key types and contracts

See "Frozen contracts" in `tasks.md` until WP-1 lands them in code.

## Tests

| File | Covers |
|---|---|
| *(none yet — each package in `tasks.md` names its own)* | |

## Known limitations and TODOs

Listed in STEPS.md S10.7's backlog bullet.
