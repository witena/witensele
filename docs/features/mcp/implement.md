# mcp — Implement

## Approach

Three layers, each testable without the one above it:

```
mcp/tools.ts     pure      MCP tool definitions + a `call` fn → an AI SDK ToolSet
mcp/manager.ts   stateful  connection pool, discovery, execution, probing
handlers/mcp.ts  transport validation, connection invalidation, unbinding
```

`agent-turn.ts` is the only consumer inside the backend: it asks the manager for
each bound server's tools, wraps them with `toAiTools`, and hands the result to
`streamText`.

## Data flow

### Registering a server

```
Settings → MCP servers → Add
  renderer  useMcpStore.startCreate()            → draft: McpServerInput
  renderer  McpEditor edits the draft            (no round trip)
  renderer  Test → backend.invoke('mcp.testConnection', { server: { draft } })
  main      handlers/mcp validates the draft
  main      McpManager.testConnection()          → fresh client, listTools, close
  renderer  the tool list renders under the buttons
  renderer  Save → backend.invoke('mcp.create', { input: draft })
  main      repos.mcpServers.create()            → McpServer
  renderer  the probe result is re-keyed from `draft` to the new id
```

No event is emitted. The registry is edited on one screen by one user, so the
store applies its own writes — the same rule `stores/agents.ts` follows.

### One tool call inside a turn

```
main  runAgentTurn
      └ collectAgentTools(ctx, agent, { signal, toolTimeoutMs })
          for each agent.mcpServerIds:
            record exists?  enabled?  (sideEffects → role === 'executor')?
            ctx.mcp.listTools(id)        → connects on first use
            toAiTools(id, name, tools, call)
      └ streamText({ tools, stopWhen: stepCountIs(MAX_TOOL_STEPS), … })
          fullStream part 'tool-call'
            → ToolCallPart { toolCallId, toolName, input, serverId, serverName }
            → messages.update(parts)   +  message.delta { kind: 'part' }
          the SDK runs `execute`
            → McpManager.callTool(id, name, args, { signal, timeoutMs })
            → client.callTool → { content, isError }
            → renderToolResult() → text     (isError → throw McpToolError)
          fullStream part 'tool-result' | 'tool-error'
            → ToolResultPart { toolCallId, output, isError? }
            → messages.update(parts)   +  message.delta { kind: 'part' }
          the SDK calls the model again with the result; text streams as usual
      └ terminal update: parts, status, usage (summed over every step)
```

Every part reports `ctx.supervisor.activity()`, so an agent waiting on a slow
tool is `working`, not stalled.

## Key types

| Type | Where | Purpose |
|---|---|---|
| `McpServer` / `McpServerInput` | `shared/types.ts` | The stored record and its write payload (unchanged by this step) |
| `McpToolInfo` | `shared/types.ts` | `{ name, description? }` — what the renderer lists. **No schema crosses the boundary** |
| `McpConnectionTestResult` | `shared/types.ts` | `ConnectionTestOk & { tools: McpToolInfo[] }`, or a failure |
| `McpServerRef` | `shared/backend.ts` | `{ id } \| { draft }`, so an unsaved form is testable |
| `ToolCallPart` | `shared/types.ts` | Gained `serverId?` and `serverName?` |
| `McpToolDefinition` | `main/mcp/tools.ts` | One tool as `listTools` reports it, narrowed to three fields |
| `McpCallResult` | `main/mcp/tools.ts` | `{ content?, isError?, structuredContent? }` |
| `AgentTools` | `main/mcp/tools.ts` | `{ tools: ToolSet, origins: Record<key, ToolOrigin> }` |
| `CreateTransport` | `main/mcp/manager.ts` | Injected transport factory; tests pass an in-memory one |

## IPC contract

| Method | Input | Output |
|---|---|---|
| `mcp.list` | — | `McpServer[]` |
| `mcp.create` | `{ input: McpServerInput }` | `McpServer` |
| `mcp.update` | `{ id, patch }` | `McpServer` |
| `mcp.delete` | `{ id }` | `void` |
| `mcp.testConnection` | `{ server: McpServerRef }` | `McpConnectionTestResult` |
| `mcp.tools` | `{ id }` | `McpToolInfo[]` |
| `mcp.log` | `{ id }` | `string[]` |

`mcp.tools` and `mcp.log` are **new in S3.1** and were added to `BackendApi`,
`BACKEND_METHODS` and `shared/contracts.test.ts` together.

## Tests

| File | What it covers |
|---|---|
| `src/main/mcp/tools.test.ts` | Sanitizing, the `${slug}__${tool}` key, the reverse map, the schema passed through untouched, `call` receiving the **original** name, text joining, the image summary, resources, `structuredContent`, `isError` → throw, and the first-wins collision rule |
| `src/main/mcp/manager.test.ts` | Against a **real** in-process MCP server: discovery, one connection for concurrent callers, reconnection after a failure, a disabled server refused, `refresh` re-listing over the same connection, a tool call, `isError`, the timeout, the abort, an unknown tool, `testConnection` (success, pool untouched, unreachable, unconnectable), `disconnect`, the stderr buffer |
| `src/main/handlers/mcp.test.ts` | Validation (duplicate names, stdio without a command, http without a valid URL, a non-http scheme), the merged-record patch rule, connection invalidation, the delete unbinding, probing a draft, `tools` and `log` |
| `src/main/agents/agent-turn.test.ts` | The loop end to end: a `MockLanguageModelV4` that calls a tool then answers, against the in-process server — parts in order, `part` deltas before text, usage summed over two steps, a failed tool stored as an errored result, **the side-effects rule for a participant and for an executor**, a disabled server, the tools-unsupported retry and its once-per-chat notice, and an unreachable server that still lets the agent answer |
| `src/renderer/src/components/settings/mcp-display.test.ts` | Status precedence and the endpoint line |
| `src/renderer/src/components/chat/tool-call.test.ts` | The `serverName · toolName` label |
| `e2e/mcp.spec.ts` | The real thing: `npx @modelcontextprotocol/server-everything` spawned by the built app, its tools listed before Save, the record and the agent binding surviving a restart, and — when `qwen2.5:3b` is on Ollama — an agent actually calling `echo` |

`src/main/mcp/testing.ts` is what makes most of that cheap: an SDK `McpServer`
with `echo` / `fail` / `slow`, linked to the client by `InMemoryTransport`. It is
a genuine protocol implementation, so the tests prove the manager against MCP
rather than against a fake that was written to agree with it.

## Known limitations and TODOs

- `notifications/tools/list_changed` is not subscribed to; the tool list is
  cached per connection and only `refresh: true` re-asks.
- An agent takes all of a server's tools or none.
- An http server's headers are stored in the record's `env` map, because it is
  the same idea in both transports and widening `McpServerInput` for one extra
  string map would cost a migration. The editor labels it "Headers" when the
  transport is http.
- No OAuth (`authProvider`).
- `AppContext.close()` does not await `closeAll()` — see `backend.md`.
