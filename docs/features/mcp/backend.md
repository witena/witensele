# mcp — Backend

## Modules

| File | Responsibility |
|---|---|
| `src/main/mcp/manager.ts` | `McpManager`: the connection pool, `listTools`, `callTool`, `testConnection`, `disconnect` / `closeAll`, the stderr ring buffer, and the two transport factories |
| `src/main/mcp/tools.ts` | Pure: naming (`${slug}__${tool}`), `jsonSchema()` wrapping, MCP result → text, `isError` → throw |
| `src/main/mcp/testing.ts` | An in-process `McpServer` over `InMemoryTransport` for the suite. Not imported by production code |
| `src/main/handlers/mcp.ts` | The seven `mcp.*` handlers: validation, connection invalidation, unbinding on delete |
| `src/main/agents/agent-turn.ts` | `collectAgentTools` (the side-effects rule), the tool parts, the tools-unsupported fallback |
| `src/main/db/repositories/agents.ts` | Gained `removeMcpServer(serverId)` |
| `src/main/app-context.ts` | `ctx.mcp`, built by `createMcpManager`; `closeAll()` from `ctx.close()` |

None of them imports electron. `McpManager` receives `getServer` by injection and
reaches the database through nothing else (CLAUDE.md rule #5).

## Database

No migration: the `mcp_servers` table has existed since S1.2 and this step is the
first to read it for anything but CRUD.

| Table | Column | Type | Notes |
|---|---|---|---|
| `mcp_servers` | `name` | text | **Also the tool prefix.** Unique per user, case-insensitively, enforced in the handler |
| | `transport` | `'stdio' \| 'http'` | Decides which of the next four columns mean anything |
| | `command`, `args`, `env` | text / JSON | stdio. `env` is merged over `process.env`. `args` arrives already normalised (trimmed, no empty strings): the renderer's `textToArgs` does that, never this layer |
| | `url` | text | http. `env` doubles as the request headers |
| | `enabled` | boolean | A disabled server is never connected and offers no tools |
| | `side_effects` | boolean | Attached to `executor` agents only |
| `agents` | `mcp_server_ids` | JSON | **Not a foreign key**, so `mcp.delete` unbinds by hand via `repos.agents.removeMcpServer` |
| `messages` | `parts` | JSON | Now also holds `tool-call` (with `serverId` / `serverName`) and `tool-result` parts |

## IPC handlers

| Channel | Input | Output | Errors |
|---|---|---|---|
| `mcp.list` | — | `McpServer[]` | — |
| `mcp.create` | `{ input }` | `McpServer` | `validation`: empty or duplicate name; stdio without a command; http without a valid http(s) URL; a non-string `args` / `env` |
| `mcp.update` | `{ id, patch }` | `McpServer` | `not_found`; `validation` — the transport requirement is checked against the **merged** record, so `{ transport: 'http' }` alone fails and `{ enabled: false }` alone does not |
| `mcp.delete` | `{ id }` | `void` | `not_found` |
| `mcp.testConnection` | `{ server: McpServerRef }` | `McpConnectionTestResult` | `validation` for a draft that could never connect; `not_found` for an unknown id. A server that will not start is a **resolved** `{ ok: false }`, not a rejection |
| `mcp.tools` | `{ id }` | `McpToolInfo[]` | `not_found`; `mcp_error` when the server cannot be reached or is disabled |
| `mcp.log` | `{ id }` | `string[]` | `not_found` |

Side effects worth knowing:

- **`mcp.update` disconnects** when `enabled` goes false or any of `transport`,
  `command`, `args`, `env`, `url` is present in the patch — *after* the write, so
  a rejected update leaves the live client untouched.
- **`mcp.delete` disconnects first**, then unbinds the id from every agent, then
  deletes the row. Closing first means no stdio child outlives the record that
  knows how to stop it.

## Events emitted

None of its own. The registry is single-screen, single-user state, so the store
applies its own writes. The turn's tool activity reaches the renderer through
`agent-turn`'s existing events:

| Event | Payload | Emitted when |
|---|---|---|
| `message.delta` | `{ delta: { kind: 'part', part } }` | A `tool-call` or `tool-result` part is appended |
| `presence.changed` | `{ presence }` | Indirectly: every tool part is reported as `supervisor.activity()` |
| `message.created` | the `toolsUnsupported` notice | A model rejected tools and the turn was retried without them |

## Filesystem and processes

A stdio server is a **child process**, spawned by `StdioClientTransport` with:

- `command` and `args` from the record,
- `env` = `process.env` with the record's `env` merged over it,
- `cwd` = the user's home directory (`os.homedir()`), not the app bundle, so a
  filesystem server's relative paths mean what the user expects,
- `stderr: 'pipe'`, captured into a 200-line ring buffer per server.

`ctx.close()` calls `closeAll()` **without awaiting it** — `close()` is
synchronous because every caller is (electron's `will-quit`, a test's
`afterEach`), and the transport kills the child, so nothing leaks by not waiting.

### Security posture, stated plainly

Registering an MCP server means asking the app to run an arbitrary command with
the user's privileges. The environment is therefore **not** filtered: the SDK's
`getDefaultEnvironment()` allowlist would break `npx`, `uvx` and `docker` without
protecting anything a registered command could not already read from disk. The
real boundary is the register step itself, plus the `sideEffects` flag, which
decides whether a *model* is allowed to reach the mutating half of a server.

## External dependencies

### `@modelcontextprotocol/sdk` — verified against the installed types

Read from `node_modules/@modelcontextprotocol/sdk/dist/esm/**` (**1.30.0**), not
from memory.

| Name | Module | Shape used here |
|---|---|---|
| `Client` | `…/client/index.js` | `new Client({ name, version }, { capabilities: {} })` |
| `Client.connect` | | `connect(transport, options?)`, performs `initialize` |
| `Client.listTools` | | `listTools()` → `{ tools: { name, description?, inputSchema, outputSchema?, annotations? }[] }` |
| `Client.callTool` | | `callTool({ name, arguments }, resultSchema?, options?)` → `{ content: […], isError?, structuredContent? }` |
| `Client.close` | | Closes the transport; for stdio that kills the child |
| `StdioClientTransport` | `…/client/stdio.js` | `{ command, args?, env?, cwd?, stderr?, maxBufferSize? }`; `.stderr` getter, `.pid` getter |
| `StreamableHTTPClientTransport` | `…/client/streamableHttp.js` | `new (url: URL, { requestInit?, authProvider?, fetch?, sessionId? })` |
| `RequestOptions` | `…/shared/protocol.js` | `{ signal?, timeout?, onprogress?, resetTimeoutOnProgress?, maxTotalTimeout? }` — third argument of `callTool` |
| `Transport` | `…/shared/transport.js` | The interface both transports implement |
| `InMemoryTransport` | `…/inMemory.js` | `InMemoryTransport.createLinkedPair()` → `[clientSide, serverSide]` |
| `McpServer` | `…/server/mcp.js` | `registerTool(name, { description, inputSchema }, cb)`; `inputSchema` is a **zod raw shape**, not a JSON Schema |

Pitfalls, each one hit while writing this step:

- **`callTool` *does* support cancellation and a timeout.** The third argument is
  a `RequestOptions` with `signal` and `timeout`, so the request is genuinely
  cancelled rather than merely abandoned. An earlier assumption that it did not
  would have produced an outer `Promise.race` that leaves the server working on a
  request nobody will read. The SDK's timeout surfaces as an `McpError` whose
  message contains "timed out"; the manager maps that to
  `BackendFailure('mcp_error', 'tool timeout')`.
- **An unknown tool name is *not* a rejection.** `callTool('nope')` resolves with
  `{ isError: true, content: [{ text: 'MCP error -32602: Tool nope not found' }] }`.
  That is the right behaviour — the model is told and can pick another tool — but
  a test that expects a throw will fail, and code that only checks for rejection
  will treat the failure as a success.
- **`StreamableHTTPClientTransport` does not satisfy `Transport` under
  `exactOptionalPropertyTypes`.** The class declares `sessionId: string |
  undefined`, the interface declares `sessionId?: string`. The shapes are
  identical at runtime; `manager.ts` carries one documented cast rather than the
  project relaxing the compiler flag.
- **`transport.stderr` is available before `start()`.** It is a `PassThrough`
  returned immediately, so a listener attached at construction catches the
  child's earliest output — which is exactly the output that explains a failure
  to start. Attaching it after `connect()` loses it.
- **The subpath exports are `./dist/esm/*` via a wildcard**, so
  `@modelcontextprotocol/sdk/client/stdio.js`, `…/server/mcp.js` and
  `…/inMemory.js` all resolve, with the `.js` extension required.
- **`McpServer.registerTool` wants zod, not JSON Schema**, which matters only in
  `mcp/testing.ts`. The SDK accepts zod 3 or 4; this project has zod 4.

### `ai` 7 — the tool half, verified against `node_modules/ai/dist/index.d.ts` (**7.0.99**)

This extends the table in [`../agent-turn/backend.md`](../agent-turn/backend.md).

| Name | Package | Shape used here |
|---|---|---|
| `tool` | `ai` (re-exported from `@ai-sdk/provider-utils`) | `tool({ description?, inputSchema, execute })` |
| `jsonSchema` | same | `jsonSchema<T>(schema)`, where `schema` is a `JSONSchema7` |
| `ToolSet` | `ai` | `Record<string, Tool>` — the flat namespace a model sees |
| `stepCountIs` | `ai` | Exported as an **alias of `isStepCount`**; `stopWhen: stepCountIs(8)` |
| `streamText` | `ai` | Gained `tools` and `stopWhen` here |
| `TextStreamToolCallPart` | `ai` | `{ type: 'tool-call', toolCallId, toolName, input }` — `input` is already **parsed** |
| `TextStreamToolResultPart` | `ai` | `{ type: 'tool-result', toolCallId, toolName, input, output }` |
| `TextStreamToolErrorPart` | `ai` | `{ type: 'tool-error', toolCallId, toolName, input, error }` |
| `TextStreamFinishPart.totalUsage` | `ai` | "When there are multiple steps, the usage is the sum of all step usages" — so a tool loop needs **no** accumulation of its own |

Pitfalls:

- **`input` is a string at the provider level and an object at the `ai` level.**
  `LanguageModelV4ToolCall.input` is stringified JSON (what a `MockLanguageModelV4`
  must emit); the `ai`-level `tool-call` part carries the parsed object (what the
  message part stores). Writing a mock from the wrong one produces a stream that
  parses into nothing.
- **A thrown `execute` becomes a `tool-error` part, not a rejected stream.** That
  is what makes `isError → throw` the right mapping: the turn continues, the model
  is told, and the card can show it red.
- **`jsonSchema()` keeps the original object** reachable as `.jsonSchema`, which
  is how `tools.test.ts` asserts the MCP schema was passed through untouched.
- **`@ai-sdk/provider` is not a declared dependency.** `JSONSchema7` is only
  reachable through it, so `tools.ts` derives the type as
  `Parameters<typeof jsonSchema>[0]` instead of importing from a transitive package.
- **Tool names must match `[a-zA-Z0-9_-]`.** A dot or a space is rejected by
  OpenAI-compatible endpoints outright, which is why both halves of the key are
  sanitized rather than only the server's.
