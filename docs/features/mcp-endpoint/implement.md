# mcp-endpoint — Implementation

> Partly built. `backend.md`'s table is the authority on which work package has
> landed; `src/mcp-shim/` is still entirely to come. The design is PLAN.md
> "Witena as an MCP server (the MCP endpoint)"; the types every package codes
> against are under "Frozen contracts" in [`tasks.md`](./tasks.md). Each work
> package replaces part of this file with what it actually built.

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

"Frozen contracts" in `tasks.md` is still the list of everything Phase 10 will
have. What exists in code today is WP-1's two shared modules, which the shim and
the endpoint both import.

### `src/shared/mcp-tools.ts`

| Export | What it is |
|---|---|
| `MCP_SERVER_NAME` (`'witena'`), `MCP_PATH` (`'/mcp'`), `CLIENT_HEADER` (`'x-witena-client'`) | The three names both halves have to spell identically |
| `MCP_TOOL_NAMES`, `McpToolName` | The six tools, in the order `tools/list` presents them |
| `MIN_WAIT_SECONDS` 5, `MAX_WAIT_SECONDS` 600, `DEFAULT_WAIT_SECONDS` 50 | The chunking window PLAN's decision table describes. WP-0b may move the default |
| `MAX_DISCUSSION_INPUT_CHARS` 200 000, `MAX_POSITION_CHARS` 4 000 | The two caps WP-3 enforces and names in its errors |
| `DiscussionStatus`, `DiscussionResult` | The one result shape `start_discussion`, `wait_for_discussion` and `get_discussion` all return |
| `MCP_TOOL_INPUTS` | One `z.ZodObject` per tool. `z.infer` gives WP-3 its argument type, `.parse` gives it its validation |
| `MCP_TOOLS` | `{ name, title, description, inputSchema }[]`, built from `MCP_TOOL_INPUTS` with `z.toJSONSchema` |
| `chatUrl`, `parseChatUrl` | The `witena://chat/<uuid>` deep link, written by every result and read by WP-8 |

Three things are worth knowing before coding against it:

- **The descriptions are prompts, not UI copy.** Their reader is the calling
  model, so they say what the group can and cannot do, that the *caller* applies
  the conclusion, and that `status: "running"` means call `wait_for_discussion`
  again. They never go through `t()` — CLAUDE.md rule 4 is about the renderer,
  and the calling model has no language setting.
- **`start_discussion`'s three cross-field rules live in zod refinements**, which
  have no JSON Schema representation: exactly one of `chatId` and a non-empty
  `agents`, and `title` / `workdir` only when a chat is being created. The wire
  schema therefore describes the fields and the *refusal message* describes the
  rule, which is the right way round for a model — it reads the error.
- **`MCP_TOOL_INPUTS` is declared with `satisfies`**, not with the annotation the
  contract writes. An annotation of `{ [N in McpToolName]: z.ZodObject<z.ZodRawShape> }`
  would widen every entry and `z.infer` would hand each tool an index signature
  instead of its fields. A type test pins this.

`inputSchema` is `z.toJSONSchema(schema, { io: 'input' })` with `$schema`
deleted. The dialect announcement buys a tool schema nothing, and a client that
re-describes MCP tools as its own provider's function schema can reject unknown
top-level keys.

### `src/shared/mcp-discovery.ts`

`DISCOVERY_FILE` (`mcp-endpoint.json`), `DISCOVERY_VERSION` (1), `McpDiscovery`
(`{ version, port, token, pid, startedAt }`), `parseDiscovery` and
`userDataDirFor`.

`parseDiscovery` **never throws**: absent, half-written, hand-edited, from a
future release and left behind by a dead process all come out as `null`, because
`null` is the one branch the shim has (launch the app, or tell the calling model
Witena is not up) and an exception there would reach the IDE as a crashed MCP
server. Unknown fields are ignored so that an old shim survives an app update;
an unknown `version` is not, because a later release may mean something else by
the same field names.

`userDataDirFor(env, home)` reproduces electron's macOS rule —
`~/Library/Application Support/<app name>`, with `WITENA_USER_DATA` overriding
it exactly as `src/main/index.ts` does. It is pure and takes both inputs as
arguments so a test can ask about a directory that does not exist; the app name
comes from `APP_NAME`, which `app.setName` sets before anything reads `userData`.
Neither module imports `node:` anything, and callers join `DISCOVERY_FILE` onto
the directory themselves.

### Discussion watcher (WP-2) — `src/main/mcp-endpoint/discussion.ts`

The adapter between a run, which announces itself as a stream of events, and a
calling model, which has one tool timeout and wants one answer.

| Export | Signature | Notes |
|---|---|---|
| `watchDiscussion` | `(ctx, handlers, WatchOptions) => { result: Promise<DiscussionResult>; cancel(): void }` | Subscribes **synchronously**, so WP-3 calls it before `chat.send` |
| `readDiscussion` | `(ctx, handlers, { chatId, afterSeq }) => Promise<DiscussionResult>` | No waiting: what the transcript says right now |
| `loadTranscript` | `(ctx, handlers, chatId) => Promise<Message[]>` | Oldest first, paged; index + 1 is the message's `seq` |
| `DiscussionProgress` | `(update: { message: string; round?: number }) => void` | The frozen contract's `ToolCallContext['progress']` is this type |

`WatchOptions` is the frozen contract's, with one thing made explicit that the
contract left to the reader: **`deadlineMs` is an absolute epoch-millisecond
timestamp**, `Date.now() + maxWaitSeconds * 1000`, not a duration. Its
`progress` is typed `DiscussionProgress` rather than `ToolCallContext['progress']`,
because `tools.ts` does not exist yet and the dependency runs the other way —
WP-3 defines `ToolCallContext['progress']` *from* this type, so the two cannot
drift.

The watch settles once, on the first of:

| Event | Status | Note |
|---|---|---|
| `run.finished` `completed` with a `ConclusionPart` message after `afterSeq` | `concluded` | |
| `run.finished` `completed` without one, or `max-rounds` | `ended` | `positions` is filled |
| `run.finished` `stopped` / `error` | `stopped` / `error` | `error` carries the runner's `runFailed` detail, else the failed message's `error` |
| `permission.requested` for the chat | `needs-attention` | The run keeps going; the hint names the `witena://` link |
| the deadline, or `signal` / `cancel()` | `running` | Aborting the *wait* never stops the *run* |

`readDiscussion` adds one row of its own: a chat whose runner is busy is
`running`, and an idle one is read exactly as a finished `completed` run would
be. It is also the only one of the two that throws — WP-3 turns a
`BackendFailure` into the tool's error, and `get_discussion` on an invented chat
id has to say `not_found`.

`progress` is called on `run.round` ("Round 2 — Ada, Lin") and on each agent
`message.updated` that has reached a final status ("Ada has spoken"), with names
read once through `agents.list` and memoised on a single promise so the updates
keep their order. An update whose name lookup lands after the watch settled is
dropped: the request it would have been reported to is over.

## HTTP endpoint and guards (WP-4)

`src/main/mcp-endpoint/` now holds the transport half of the endpoint: the door
(`guards.ts`), the MCP server over Streamable HTTP (`server.ts`) and the three
types the tools are written against (`tool-types.ts`). The six tools themselves
are WP-3's; the endpoint takes a `ToolRegistry` by injection and a stub is what
its own tests pass.

### `src/main/mcp-endpoint/guards.ts`

Four checks run **before the SDK sees a byte**, in this order, and each is a pure
function of headers plus the port the request arrived on:

| Check | Answer | Why |
|---|---|---|
| An `Origin` header is present at all | 403 | Only a browser sends one, and no legitimate caller here is a browser — so its presence is enough and no origin ever has to be judged friendly |
| `Host` is not `127.0.0.1:<port>` or `localhost:<port>` | 403 | The DNS-rebinding defence: a page at `evil.test` that resolved to loopback still sends its own name. `<port>` is `req.socket.localPort` |
| No bearer token, or the wrong one | 401 | `timingSafeEqual` over equal-length buffers; an empty configured token never matches |
| A body over `MAX_BODY_BYTES` (8 MiB) | 413 | Checked while reading, not from `content-length`, which is what the caller claims |

A repeated `Authorization`, `Host` or `x-witena-client` header collapses to
`undefined` rather than to its first value — a caller that sent a header twice is
not one to be charitable to. The refusal body is a JSON-RPC error object with a
null id; the HTTP status is what the shim keys its retry on.

### `src/main/mcp-endpoint/server.ts`

`createMcpEndpoint({ ctx, handlers, token, tools? })` → `{ handle, close }`.
`handle` answers `MCP_PATH` and 404s everything else, so a host that multiplexes
can route with the exported `isMcpPath` first. One SDK `Server` +
`StreamableHTTPServerTransport` is built **per request** (stateless: the SDK
requires a fresh transport in that mode, and a discussion's state is the chat).

- `tools/list` → `MCP_TOOLS` verbatim, which is the same table the shim serves
  offline.
- `tools/call` → the registry, with `client` captured from `CLIENT_HEADER` in the
  request closure, `signal` from the SDK's handler extra, and `progress` only
  when the call carried `_meta.progressToken`.
- A name that is not in `MCP_TOOL_NAMES` is a JSON-RPC error
  (`InvalidParams`), not an `isError` result: the specification reserves
  protocol errors for "errors in finding the tool".
- `ToolOutcome` `ok` → `{ content: [{ type: 'text', text }], structuredContent }`;
  not ok → `isError: true` with `"<code>: <message>"`, so the calling model can
  read the failure and correct itself.
- `structuredContent` is set only when `structured` is a plain object, because
  that is all MCP allows there. An array or a primitive is dropped rather than
  wrapped in an invented key — `text` renders the same value either way. **Tools
  return objects.**
- `close()` closes every transport still on the wire, which aborts the tool calls
  riding on them, and answers 503 to anything that arrives afterwards.

Two behaviours are worth knowing before writing against it:

**Cancellation rides the socket.** A client that cancels sends
`notifications/cancelled` as its *own* HTTP request, which in stateless mode
reaches a new `Server` that has never heard of the call it names — so it cannot
abort it. What does abort a running tool is the caller dropping its HTTP request:
the response closes, `res.on('close')` closes the transport, and the SDK's
`Protocol._onclose` aborts every in-flight request handler, which is the `signal`
in `ToolCallContext`. The shim therefore cancels by abandoning its request
(closing, or per-call scoping, its `StreamableHTTPClientTransport`), not by
sending a notification.

**Progress is a counter plus a sentence.** MCP's progress notification carries
`progress` (a number that must increase) and `message`, and nothing else — so
`ToolCallContext.progress`'s `round` rides in the message text the watcher writes
("Round 2 — Ada, Lin") and `progress` counts the updates. A caller that passed no
`progressToken` gets no callback at all rather than a no-op one, so a tool can
tell "nobody is listening" from "listening, nothing happened".

### `src/main/mcp-endpoint/tool-types.ts` — and the one seam WP-3 fills

"Frozen contracts" puts `ToolCallContext`, `ToolOutcome` and `ToolRegistry` in
`tools.ts` beside `createTools()`, and `McpEndpointOptions.tools` defaults to
`createTools()`. WP-3 writes that file after WP-4, so the three declarations live
in `tool-types.ts` and `server.ts` imports them from there. When `tools.ts` lands:

1. `export type { ToolCallContext, ToolOutcome, ToolRegistry } from './tool-types'`
   at the top of `tools.ts`, so the contract reads where it says it reads.
2. Replace the body of `missingToolRegistry()` in `server.ts` with
   `return createTools()`. That function currently throws a sentence naming this
   step — a wiring mistake must not become six tools that answer "unknown tool".

Nothing else in `server.ts` changes.

**Both were done by WP-3** (2026-09-20). `tools.ts` re-exports the three types,
and the default registry is now `defaultToolRegistry()`, whose whole body is
`return createTools()`. `tool-types.ts` still holds the declarations, because
moving them would only relocate the same three lines and break the import
`server.ts` already has.

## The discussion tools (WP-3) — `tools.ts` and `transcript.ts`

`createTools()` returns the `ToolRegistry` the transport takes by injection, and
`tools.ts` re-exports `ToolCallContext`, `ToolOutcome` and `ToolRegistry` from
`./tool-types`, so the frozen contract reads where it says it reads. The seam in
`server.ts` is closed: its default registry is `createTools()`.

Every tool is wrapped by one function, which is where three of the four rules in
the file header stop being something each tool has to remember:

```
tools/call → MCP_TOOL_INPUTS[name].safeParse  → validation, in zod's own words
           → the implementation               → ToolOutcome
           → anything thrown                  → BackendFailure's code, else internal
```

| Tool | What it does beyond calling a handler |
|---|---|
| `list_chats` | Filters case-insensitively over the title **and the member names**, and flags a chat whose runner is live as `running`. Not `chats.search`: that also searches message bodies, and an answer that changed because a word appeared inside a message is a surprising thing to give a model |
| `list_agents` | Labels each agent `<provider> · <model>` and marks an `executor` `invitable: false` |
| `start_discussion` | Resolves the group, creates or continues the chat, sends, and waits. The order is load-bearing; see below |
| `wait_for_discussion` | Reads the window from the chat's last **user** message, then either answers from the transcript (idle) or attaches a watcher (running) |
| `get_discussion` | `conclusion` → `readDiscussion` over the same window; `transcript` → `renderTranscript` over the whole chat, or over what follows `afterMessageId` |
| `stop_discussion` | `chat.stop`, plus the `wasRunning` the caller cannot otherwise know |

### `start_discussion`, in order

1. **The deadline first.** `Date.now() + (maxWaitSeconds ?? DEFAULT_WAIT_SECONDS)
   * 1000` is taken before anything else, so the budget measures the caller's
   wait and not what was left of it after a chat was created. `maxWaitSeconds`
   has no zod default — the bounds are the schema's, the default is the tool's.
2. **The input cap.** `question.length + context.length` against
   `MAX_DISCUSSION_INPUT_CHARS`, refused with the number in the message so the
   caller can trim rather than guess.
3. **The chat.** `chatId` → `chats.get` (so an invented id is `not_found` before
   anything is sent) and `busy` when its runner has live state. Otherwise the
   group is resolved and `chats.create` is called with `memberAgentIds`, the
   `title` (the question's first non-empty line, 60 characters) and `workdir`.
4. **`watchDiscussion` before `chat.send`**, because a short discussion can reach
   `run.finished` inside the same turn of the event loop the send resolved in. If
   the send throws, `cancel()` runs before the error is re-thrown into the
   wrapper: a subscription made in front of a send that never happened must not
   outlive the call.

Name resolution is **id first, then a case-insensitive exact name**. Exact rather
than fuzzy because the caller has just been handed the list by `list_agents`, so
a near-match is far likelier to be a different agent than a typo; and every
refusal names what it could not use *and* what it could have used, because a
model told only "unknown agent" can do nothing but guess again.

### `transcript.ts`

Pure: rows plus an `agentId → name` map in, markdown out. `**Name** (round n)`
headers, the conclusion marked in its own header, one line per tool call, and
reasoning dropped entirely — a `ReasoningPart` is a model talking to itself, and
handing one model's private thinking to another is the opposite of what a
transcript is for. A status worth a word (`passed`, `skipped`, `error`) is in the
header; a `SystemNoticePart` renders as its key, because the backend writes
notices as a key plus parameters and this transcript has no translator.

It is a second rendering of the same rows rather than a reuse of the renderer's
`transcript-rows.ts`: one produces a React model with streaming states and
collapsible blocks, the other produces text, and the two have no shape in common.

## Tests

| File | Covers |
|---|---|
| `src/main/mcp-endpoint/discussion.test.ts` | Every row of the status table above, through a **real** run (real `AppContext`, real `buildHandlers()`, real `ChatRunner`, `MockLanguageModelV4`): consensus → `concluded` with the conclusion's text and author; a `rounds: 1` chain → `ended` with one truncated position per member; the deadline → `running`, then a second watch → the final result; `chat.stop` → `stopped`; a throwing model → `error`; an emitted `permission.requested` → `needs-attention`; abort and `cancel()` → `running`, with the run still finishing afterwards. Plus the `seq`-is-a-position assumption, paging past one page, `afterSeq` scoping, and — in an `afterEach` every case goes through — the event bus ending with as many listeners as it started with |
| `src/shared/mcp-tools.test.ts` | The wire shape of every `inputSchema`; names against `MCP_TOOL_NAMES`; `start_discussion`'s three refinements; the wait and round bounds; `chatUrl` / `parseChatUrl`; the `z.infer` type test; that the module imports `zod` and nothing else |
| `src/shared/mcp-discovery.test.ts` | Every way the discovery file can be wrong; `userDataDirFor` with and without the override; that the module stays pure |
| `src/main/mcp-endpoint/guards.test.ts` | Each guard as a sentence, without a socket: the path claim; any `Origin`; a foreign `Host`, loopback on another port, a missing one; the bearer in every malformed spelling; the order the three run in; a repeated header; the body cap at, one over, and not-JSON |
| `src/main/mcp-endpoint/server.test.ts` | A real listener driven by the SDK `Client`: `tools/list`; a call arriving with its arguments, `ctx`, `handlers` and `client`; `isError` for a failed outcome and for a tool that throws; a protocol error for an unknown tool; progress relayed in order and absent when unasked; `signal` aborting when a raw `fetch` is abandoned and when a client closes mid-call; `close()` aborting in-flight calls; the five refusals by raw request; `ToolOutcome` → `CallToolResult` without a socket |
| `src/main/mcp-endpoint/no-electron.test.ts` | The import closure of `src/main/mcp-endpoint/` reaches `app-context.ts` and `chat-runner.ts` and contains no `electron`, in any of its spellings (CLAUDE.md rule 5) |
| `src/main/mcp-endpoint/tools.test.ts` | All six against a **real** backend (real `AppContext`, real `buildHandlers()`, real `ChatRunner`, `MockLanguageModelV4`): each tool's happy path; name resolution by id, by name and by case, ambiguous and unknown; an executor refused; `busy` on a chat that is still talking; both caps; a relative and a missing `workdir` (and that neither left a chat behind); a `chat.send` that fails releasing the watcher; `wait_for_discussion` on an idle chat with and without a conclusion, and giving up at the deadline; `get_discussion` both details and `afterMessageId`; `stop_discussion` running and idle; `not_found` surfacing as `not_found`; and, for every tool, that garbage arguments are refused rather than thrown. In `afterEach`: the bus ends with as many listeners as it started with |
| `src/main/mcp-endpoint/transcript.test.ts` | The rendering, from hand-built rows: the header shape, the conclusion mark, a tool call on one line and a failed one marked, reasoning and `[AGREED]` absent, `passed` / `skipped` / `error` in the header, a notice as its key, an unnamed agent as its id, and an empty transcript saying so |

## Known limitations and TODOs

Listed in STEPS.md S10.7's backlog bullet.
