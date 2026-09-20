# mcp-endpoint — Implementation

> Partly built: WP-1's contracts are in the tree; everything under
> `src/main/mcp-endpoint/` and `src/mcp-shim/` is still to come. The design is
> PLAN.md "Witena as an MCP server (the MCP endpoint)"; the types every package
> codes against are under "Frozen contracts" in [`tasks.md`](./tasks.md). Each
> work package replaces part of this file with what it actually built.

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

## Tests

| File | Covers |
|---|---|
| `src/main/mcp-endpoint/discussion.test.ts` | Every row of the status table above, through a **real** run (real `AppContext`, real `buildHandlers()`, real `ChatRunner`, `MockLanguageModelV4`): consensus → `concluded` with the conclusion's text and author; a `rounds: 1` chain → `ended` with one truncated position per member; the deadline → `running`, then a second watch → the final result; `chat.stop` → `stopped`; a throwing model → `error`; an emitted `permission.requested` → `needs-attention`; abort and `cancel()` → `running`, with the run still finishing afterwards. Plus the `seq`-is-a-position assumption, paging past one page, `afterSeq` scoping, and — in an `afterEach` every case goes through — the event bus ending with as many listeners as it started with |
| `src/shared/mcp-tools.test.ts` | The wire shape of every `inputSchema`; names against `MCP_TOOL_NAMES`; `start_discussion`'s three refinements; the wait and round bounds; `chatUrl` / `parseChatUrl`; the `z.infer` type test; that the module imports `zod` and nothing else |
| `src/shared/mcp-discovery.test.ts` | Every way the discovery file can be wrong; `userDataDirFor` with and without the override; that the module stays pure |

## Known limitations and TODOs

Listed in STEPS.md S10.7's backlog bullet.
