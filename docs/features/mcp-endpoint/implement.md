# mcp-endpoint — Implementation

> Partly built. `backend.md`'s table is the authority on which work package has
> landed; the Integrations *section* (WP-12) is still to come, its backend
> (WP-11) is here. The design is PLAN.md
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

A fourth piece is not a layer but a handful of lines in the Electron entry:
**how the app is started and how a link gets back into it** (WP-8,
`src/main/launch-args.ts` plus `src/main/index.ts`). It is the only part of this
feature that is allowed to import electron, which is exactly why it lives
outside `src/main/mcp-endpoint/` — see "Launch, lock and deep link" below.

A fifth is not code this project runs at all: **`build/witena-mcp`** (WP-9), the
twenty-line POSIX shell script that `electron-builder.yml` ships as
`Contents/Resources/bin/witena-mcp` and that an IDE actually spawns. It `exec`s
the bundle's own binary on the shim with `ELECTRON_RUN_AS_NODE=1`; every line of
it is explained in [`../packaging/backend.md`](../packaging/backend.md), "The MCP
launcher", and what this feature depends on is in
[`backend.md`](./backend.md), "The bundled launcher".

## Data flow

IDE agent → `tools/call` on stdio → shim → (launch the app if needed) → Streamable
HTTP `POST /mcp` with the bearer token → guards → tool → `watchDiscussion`
subscribes → `handlers['chat.send']` → `ChatRunner` runs as for any message →
`run.finished` → `readDiscussion` → `DiscussionResult` → tool result → shim → IDE.
The window, if open, sees the same events on the same bus.

The way back, which is WP-8's: the tool result carries `chatUrl(chatId)`, and a
user who clicks it gets `witena://chat/<id>` → LaunchServices → `open-url` (or a
second launch, whose argv is handed to `second-instance`) → `src/main/index.ts`
→ show or create the window → `ui.open-chat` on the same bus → the chats store
selects it. If the app was not running at all, the same link starts it; if it
was running in the background with no window, the link is what makes one.

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
| `chatUrl`, `parseChatUrl` | The `witena://chat/<uuid>` deep link, written by every result, read by WP-8, and the uri of every chat resource (WP-15) |
| `MCP_PROMPT_NAMES`, `MCP_PROMPTS`, `MCP_PROMPT_INPUTS`, `renderPrompt` (WP-15) | The `consult` prompt: its argument table as MCP declares it, the zod shape both sides parse `arguments` with, and the pure function that expands it. See "Resources and the prompt" below |

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

### Launch, lock and deep link (WP-8)

The only electron-facing part of this feature, and therefore the one that is
kept as small and as pure as it can be made.

| Export | Where | What it is |
|---|---|---|
| `parseLaunchArgs(argv)` | `src/main/launch-args.ts` | `{ background: boolean; openChatId: string \| null }`. Scans every entry after `argv[0]` for the literal `--background` and for the first argument `parseChatUrl` accepts |
| `BACKGROUND_FLAG` | same | `'--background'`, the flag the shim passes through `open --args` |
| `CHAT_URL_SCHEME` | same | `'witena'`, for `setAsDefaultProtocolClient` and for `protocols` in `electron-builder.yml` |
| `UiOpenChatEvent` | `src/shared/events.ts` | `{ type: 'ui.open-chat'; chatId }`, the one event about the interface rather than the data |
| `ChatsState.applyOpenRequest` | `src/renderer/src/stores/chats.ts` | Selects the chat if this window has it; returns whether it did |

Three things decided here rather than in PLAN:

- **The parser scans, it does not count.** WP-0a measured a packaged launch's
  argv as exactly `['<bundle>/Contents/MacOS/Witena', '--background']`, while a
  development launch is given the app directory and whatever switches the
  Playwright harness adds. Matching the literal flag anywhere after the
  executable is the one rule that is right for both shapes; a fixed position
  would be right for one and wrong for the shipped one.
- **`argv[0]` is never read**, because it is a path the process was started
  from, never something a user asked for.
- **The scheme is duplicated, and pinned by a test.** `src/shared/mcp-tools.ts`
  keeps `CHAT_URL_PREFIX` private, so `index.ts`, `electron-builder.yml` and
  that module each spell `witena` themselves;
  `src/main/launch-args.test.ts` asserts that `chatUrl` really writes
  `${CHAT_URL_SCHEME}://`, which turns a drift into a failing test rather than
  into a link the app does not answer.

[backend.md](./backend.md) has the ordering rules inside `src/main/index.ts` —
why the lock is asked for after the `userData` override, and why `ui.open-chat`
is emitted only once the window has finished loading. [frontend.md](./frontend.md)
has the renderer's half.

## The listening host and the setting (WP-7) — `host.ts`

`server.ts` opens no socket, because the same handler is meant to be mounted by
the Node host later (PLAN.md, "Online version"). `host.ts` is what the desktop
mounts it with, and it is the smallest module in the folder that has to be
exactly right: everything a shim knows about the endpoint comes out of it.

| Export | Signature | Notes |
|---|---|---|
| `McpEndpointHost` | `{ state, start(), stop() }` | `state` is `{ listening: false } \| { listening: true; port }`, so a caller that narrowed on the flag has the port |
| `createMcpEndpointHost` | `({ ctx, handlers, userDataDir, randomToken?, pid? }) => McpEndpointHost` | `randomToken` and `pid` exist for the tests; production takes 32 random bytes and `process.pid` |

| Setting | Where |
|---|---|
| `McpEndpointSettings { enabled }` | `src/shared/types.ts`, with `AppSettings.mcpEndpoint` defaulting to `{ enabled: false }` and `AppSettingsPatch.mcpEndpoint?: Partial<…>` |
| The merge | `src/main/db/repositories/settings.ts`, field by field on the read and the write — the read merge is what keeps an installation that updates into S10.3 switched off |
| The validation and the live toggle | `src/main/handlers/settings.ts` |
| `AppContext.mcpEndpoint` | `src/main/app-context.ts`, built only when `AppContextOptions.mcpEndpoint = { handlers }` is passed |

Four things are decided here rather than in PLAN:

- **The token is per `start()`, not per launch.** PLAN says "per launch", which
  is the same thing for an endpoint that is switched on once; making it per
  `start()` means switching off and on again invalidates the old one, which is
  the behaviour a user turning the switch off would expect from it.
- **The discovery file is removed synchronously, ahead of everything else in
  `stop()`.** `before-quit` cannot await, so a quit is only guaranteed to reach
  the first synchronous statement; a file left pointing at a port that is closing
  is the stale-file case the shim exists to survive, not one to manufacture.
- **`stop()` checks the file's `pid` before deleting it.** See
  [backend.md](./backend.md) — a file naming another process belongs to another
  process.
- **The host is constructed by `createAppContext` and started by
  `src/main/index.ts`.** Construction opens nothing, so every existing suite
  keeps building contexts for free; the setting is read once at launch and again
  on every toggle, and nowhere else.

The chain that makes the switch live, end to end:

```
Settings switch (WP-12)  → settings.update { mcpEndpoint: { enabled } }
  → repositories.settings.update                     the row
  → ctx.mcpEndpoint?.start() / .stop()               the socket
    → 127.0.0.1:0 + <userData>/mcp-endpoint.json 0600
      → the shim's connect() finds both              (WP-5)
```

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

## The shim (WP-5) — `src/mcp-shim/`

The command an IDE is configured with, and the only piece of Phase 10 that runs
outside the app. Three modules and one Vite target:

| Module | Does |
|---|---|
| `index.ts` | The MCP server on `StdioServerTransport`. `initialize` is the SDK's; `tools/list` is `MCP_TOOLS` with no I/O; `tools/call` opens a connection and forwards. The bundle's entry point, so it calls `main()` at the bottom of the file |
| `connect.ts` | The discovery file, the liveness checks, the one retry, the three refusals, and the real `Client` factory |
| `launch.ts` | `bundlePathFor` and the `open(1)` call, with `spawn`, the clock and the probe injected |
| `vite.mcp-shim.config.ts` | → `out/mcp-shim/witena-mcp.cjs`, one CommonJS file with the SDK and zod inlined |

### What it answers without the app

```
initialize   → the SDK, and `clientInfo.name` is remembered
tools/list   → MCP_TOOLS, verbatim, no file read and no socket
tools/call   → connect(), then forward
```

That split is PLAN.md's decision and it has two reasons, both of which are about
*not* launching Witena: an editor that opens a project must not start the app
for every MCP server in its config, and Codex gives a server only a few seconds
to come up — a shim that answered `initialize` by launching an app would lose
that race every time.

### How it finds the app

```
open()  ─→ discovery file → pid alive? ─→ connect with the bearer token
             │ no                                │ 401 / ECONNREFUSED
             ▼                                   ▼
         app up?  ── yes → "the endpoint is switched off"
             │ no                            re-read the file, once
             ▼
         launch()  ── timed out → ask "app up?" again, then one of two sentences
```

The file's contents are cached for the life of the process and thrown away the
moment the endpoint answers like a different process — a `401` (Witena
restarted and minted a new token) or an `ECONNREFUSED` (nothing is listening
there). That is exactly one retry, and it is why the token never has to appear
in an IDE's configuration file.

`appIsRunning` is a hint, not a requirement: it reads `<userData>/SingletonLock`,
the `<host>-<pid>` symlink Electron keeps there, purely to choose between two
English sentences. Every way of failing to read it answers `false`, which falls
back to the weaker message.

### The three refusals

`SHIM_ERROR_TEXT`, returned as an ordinary tool error (`isError: true`) so the
IDE shows a readable sentence rather than a server that died:

| Kind | When | Says |
|---|---|---|
| `not-running` | No endpoint, and `process.execPath` is not inside a `.app` — development, or a bare `node` | Start Witena (`npm run dev`) and turn the endpoint on |
| `endpoint-off` | No discovery file, but Witena is up | Open Settings → Integrations and turn the MCP endpoint on |
| `launch-timeout` | `open` ran and 20 s passed with no file and no app | Open Witena and check the switch |

They are written at the calling model, exactly like the tool descriptions: each
one names the next action, because an agent told only "not running" either
retries for ever or gives up. Outside i18n for the same reason (rule 4 is about
what the *user* sees).

### Forwarding, and the two things that cross with it

**Cancellation.** WP-4 established that the endpoint is stateless, so
`notifications/cancelled` reaches a `Server` that never heard of the call it
names; what aborts a running tool is the caller dropping its HTTP request. The
SDK client owns one `AbortController` per **transport**, not per request, so
every forwarded call gets its own `Client` and its own transport, closed in a
`finally` and closed early when the incoming `signal` aborts. The spawn test
drives this end to end: abort the stdio call, watch the endpoint's
`ToolCallContext.signal` fire.

**Progress.** Relayed only when the IDE asked for it — the incoming
`_meta.progressToken` is what says so. The shim passes `onprogress` to the
forwarded call, which is how the SDK mints the *second* hop's token, and each
update becomes one `notifications/progress` back to the IDE with the counter
and message it received. Only `name` and `arguments` are forwarded; the
incoming `_meta` belongs to the first hop.

**The timeout is derived, not fixed.** `forwardTimeoutMs(args)` is
`maxWaitSeconds` (or `DEFAULT_WAIT_SECONDS`) plus 30 s. Without it the SDK's
60-second default would abort every wait longer than a minute while the
discussion carried on at the other end.

### Why the build is what it is

One CommonJS file with everything inlined, because the shim runs from inside a
signed bundle that contains no `node_modules` and is started by the app's own
binary with `ELECTRON_RUN_AS_NODE=1` (WP-9). `ssr.noExternal: true` pulls the
SDK and zod in, `inlineDynamicImports` keeps it to one file, and only `node:`
builtins stay external. `npm run build` ends with `npm run mcp-shim:build`, so
`out/mcp-shim/witena-mcp.cjs` exists whenever `out/main` does.

## Provenance (WP-13) — `OriginPart`

A question that arrived from an IDE has to be distinguishable afterwards from one
the user typed, or the first thing they see on opening Witena is a discussion
they do not remember starting. The whole mechanism is one flag part and one chip.

```ts
// src/shared/types.ts
export interface OriginPart { type: 'origin'; client: string }   // in MessagePart
export const MAX_ORIGIN_CLIENT_CHARS = 40

// src/shared/backend.ts — added to chat.send's input
origin?: { client: string }
```

The path, end to end:

| Step | Where | What happens |
|---|---|---|
| The IDE names itself | `initialize.clientInfo.name` | Whatever that client calls itself: `claude-code`, `codex`, anything |
| The shim relays it | `src/mcp-shim/index.ts` (WP-5) | As `CLIENT_HEADER` (`x-witena-client`) on the forwarded HTTP request |
| The endpoint reads it | `server.ts` (WP-4) | Into `ToolCallContext.client`; `undefined` for a direct HTTP caller |
| The tool passes it | `tools.ts`, `startDiscussion` | `origin: { client: call.client ?? DIRECT_CLIENT }` on the `chat.send` call — the one line WP-13 adds here |
| The handler cleans it | `handlers/chats.ts`, `sanitizeOriginClient` | `\p{C}` stripped, trimmed, cut to `MAX_ORIGIN_CLIENT_CHARS`, trimmed again; an empty result means no origin at all |
| The runner stores it | `orchestration/chat-runner.ts`, `originParts` | `[{ type: 'origin', client }, { type: 'text', text }]` — the flag **first**, where `markConclusion` puts the other one, and only on the user message |
| The model never sees it | `agents/history.ts`, `partsToText` | Not one of the three part kinds that contribute text, so the converted messages are byte-identical with and without it |
| The row model reads it | `renderer/…/transcript-rows.ts`, `originClient` | A `string | null` on the message row, beside `conclusion` |
| The chip draws it | `renderer/…/message-item.tsx` | `t('chat.viaClient', { client })` in a `Badge` on the header line, `data-testid="message-via"` |

Nothing else in the codebase knows the part exists, which is the point of a flag:
the run, the `@` resolution, the rounds and the rendering all treat the message as
what it is — a user message — and only the two places that are *asking* about
provenance go looking for the mark.

`get_discussion`'s markdown (`transcript.ts`) deliberately does **not** show it.
The caller of that tool is the client that sent the question, so telling it that
it was the one asking is a line of noise in a transcript it pays for by the token.


## Integrations (WP-11) — `src/main/integrations/ide-clients.ts`

The capability and the policy are deliberately two modules. `ide-clients.ts`
knows *how to talk to* `claude` and `codex` and nothing about Witena's rules;
`src/main/handlers/integrations.ts` knows the rules and nothing about argument
vectors. The seam between them is four methods, and it is the seam every test
injects across.

```ts
export interface IdeClients {
  detect(id: IdeClientId): Promise<boolean>
  registered(id: IdeClientId): Promise<string | null>
  register(id: IdeClientId, command: string): Promise<void>
  unregister(id: IdeClientId): Promise<void>
}
export function createIdeClients(options?: IdeClientsOptions): IdeClients
/** Nothing installed, and a refusal for anything that would write. */
export function absentIdeClients(): IdeClients
```

| Export | What it is |
|---|---|
| `ExecFileFn`, `ExecResult`, `defaultExecFile` | The one capability the module takes by injection. It **resolves for a non-zero exit** rather than rejecting, because a non-zero exit is an answer here: `claude mcp get witena` exits 1 to say "nothing is registered". It rejects only for a binary that could not be run or one that outran `IDE_CLIENT_TIMEOUT_MS` |
| `newestVersionFirst(names)` | Version directory names ordered numerically, segment by segment. A string sort puts `2.1.9` above `2.1.10` and `2.1.30` above `2.1.275`; a non-numeric name sorts last rather than being dropped |
| `claudeCodeDirs(home)` | The globbed `…/claude-code/<version>/claude.app/Contents/MacOS` candidates, newest first, and `[]` when the root is not there |
| `parseClaudeCommand(result)` | `  Command: <path>` out of `claude mcp get`'s indented `Label: value` block. `null` for a non-zero exit, so "not registered" is never mistaken for an empty command |
| `parseCodexCommand(result)` | The `witena` entry of `codex mcp list --json`, found **by name**. Unparsable output degrades to `null` rather than throwing — the settings section has to draw something |
| `isIdeClientId(value)` | The runtime narrowing the handler validates its input with |
| `IdeClientsOptions` | `execFile`, `env`, `home`, `fallbackDirs` (per client), `timeoutMs` — everything the module reaches the outside world through, so a test reaches none of it |

`IdeClientsOptions.fallbackDirs` exists for exactly one test: *no binary
anywhere*. The environment overrides cannot express it, because
`/Applications/ChatGPT.app` really is on a machine that has ChatGPT installed,
and a suite whose result depended on that would be no suite at all.

The two CLIs' differences are a `Record<IdeClientId, IdeClientCli>` of six
fields — binary name, override variable, install locations, and the three
argument vectors — so adding a third client is one entry there, one entry in
`IDE_CLIENT_IDS`, and nothing else.

### `src/main/handlers/integrations.ts`

`integrations.status` builds `IntegrationStatus` by asking, per client, `detect`
and then — only if installed — `registered`; `stale` is
`launcherPath !== null && command !== launcherPath`. `endpoint` comes from two
different places on purpose: `enabled` from the settings row, `listening` / `port`
from `ctx.mcpEndpoint?.state`.

`integrations.connect` is the whole of the button:

1. `readClientId(input)` — an unknown id is a client bug, so a plain `validation`.
2. `ctx.mcpLauncherPath === null` → `validation` with `integrations_no_launcher`,
   before anything is spawned or stored.
3. `detect` false → `validation` with `integrations_client_not_installed`.
4. `handlers['settings.update'](ctx, { patch: { mcpEndpoint: { enabled: true } } })`
   — the handler, not the repository, because storing the row *and* starting the
   host idempotently is that handler's side effect (WP-7). It is reached as
   `settingsHandlers['settings.update']`: `buildHandlers()` is assembled *from*
   this module, so asking the built map for a sibling would be a cycle.
5. `registered` → equal to the launcher: do nothing; different: `unregister`
   then `register`; absent: `register`. `mcp add` over an existing name is an
   error in both CLIs, which is why a repair is never an overwrite.
6. Re-read and return the status.

`integrations.disconnect` refuses a client that is not installed, unregisters
only when something is registered, and leaves the endpoint listening.

## Resources and the prompt (WP-15) — `resources.ts`, `renderPrompt`, `src/mcp-shim/server.ts`

The endpoint stops being tools-only. Three methods are added to each half, and
the whole design question is *which of them may wake the app*.

### What each method answers

| Method | Endpoint | Shim |
|---|---|---|
| `resources/list` | The twenty most recently active chats as `witena://chat/<id>`, `mimeType: 'text/markdown'`, `name` and `title` both the chat's title. No `nextCursor` | Forwarded when a discovery file already describes a live app; `{ resources: [] }` otherwise |
| `resources/read` | `renderChatTranscript(ctx, handlers, chat, await loadTranscript(…))` — literally the document `get_discussion { detail: 'transcript' }` returns | Forwarded on the same condition; an `McpError` carrying `RESOURCE_UNAVAILABLE_TEXT` otherwise |
| `resources/templates/list` | `{ resourceTemplates: [] }` | The same |
| `prompts/list` | `MCP_PROMPTS` | `MCP_PROMPTS` — the same table, no I/O |
| `prompts/get` | `renderPrompt(name, arguments)` | `renderPrompt(name, arguments)` — the same function, no I/O |

Both servers now declare `{ tools: {}, resources: {}, prompts: {} }` and nothing
else: no `subscribe`, no `listChanged`. The endpoint is stateless, so a
request-scoped `Server` has nobody to notify a moment later, and a client that
subscribed to a chat would be subscribing to an object that stops existing when
the response ends.

### Which methods may launch Witena

The rule, and the reason `Connector` now has two ways in:

| Method | Connects | Launches |
|---|---|---|
| `initialize`, `tools/list`, `prompts/list`, `prompts/get` | never | **no** |
| `resources/list`, `resources/read` | only when a discovery file already names a live app (`connector.openIfRunning`) | **no** |
| `tools/call` | yes (`connector.open`) | **yes** |

WP-0b measured Claude Code sending `tools/list`, `prompts/list` *and*
`resources/list` on **every session start**. A listing that launched the app
would launch it every time a user opened an editor, which is the one thing the
whole shim exists to prevent. `resources/read` is held to the same rule by
choice: it is a browse, the user asked for a document rather than for work, and
a tool call — which does launch — is one step away. `openIfRunning` probes the
file itself rather than calling `open()`, so there is no window in which a file
that vanished between the probe and the connection could turn a listing into a
launch; and it ignores the cache, because a cached endpoint that has since gone
away would make a listing answer "running" and then fail.

### Why the prompt lives in `@shared/mcp-tools`

`renderPrompt` is a pure function of its arguments, so forwarding `prompts/get`
would be a round trip — and, in an earlier design, a launch — for a string the
shim can already produce. Sharing the function is what makes "the app and the
shim expand it identically" a fact rather than an intention.

`consult` takes `question` (required), `chat?` and `agents?`; every value is a
string, because that is all `prompts/get` carries, so `agents` is comma-separated
and the expansion tells the model to split it. It refuses `chat` and `agents`
together in the same words `start_discussion` refuses them. `committee?` is
**not** here: it belongs to WP-14, which is the package that gives
`start_discussion` a `committee` field, and an argument that expanded into an
instruction to pass one would be a prompt that teaches a model to fail.

The expansion is a numbered procedure because the two failure modes it exists to
prevent are skipping step 2 and giving up at step 3: a model that asks a group a
question without pasting the code gets a generic answer, and one that reads
`status: "running"` as an error abandons a discussion that was about to
conclude.

### The two refusals a read can produce

- A uri `parseChatUrl` rejects — another scheme, an extra path segment, an id
  that is not a uuid — never named a chat at all, so it is `InvalidParams` and
  the message points at `resources/list`.
- A well-formed uri whose chat is not in the database is `-32002` (the
  specification's "resource not found", which this SDK's `ErrorCode` enum has no
  name for; `McpError` takes a plain number). It comes from `chats.get` raising
  a `BackendFailure` with code `not_found`.

### `src/mcp-shim/server.ts`

`createShimServer` moved out of `index.ts` into its own module. `index.ts` is the
bundle's entry point and its last statement connects a `StdioServerTransport` to
the real `process.stdin`, so importing it to test a handler would start a second
MCP server on the test runner's own stdin. `index.ts` keeps the wiring — the
real connector, the transport, the bootstrap — and re-exports `createShimServer`;
everything that decides what a request *means* is in `server.ts`.

## Tests

| File | Covers |
|---|---|
| `src/main/mcp-endpoint/discussion.test.ts` | Every row of the status table above, through a **real** run (real `AppContext`, real `buildHandlers()`, real `ChatRunner`, `MockLanguageModelV4`): consensus → `concluded` with the conclusion's text and author; a `rounds: 1` chain → `ended` with one truncated position per member; the deadline → `running`, then a second watch → the final result; `chat.stop` → `stopped`; a throwing model → `error`; an emitted `permission.requested` → `needs-attention`; abort and `cancel()` → `running`, with the run still finishing afterwards. Plus the `seq`-is-a-position assumption, paging past one page, `afterSeq` scoping, and — in an `afterEach` every case goes through — the event bus ending with as many listeners as it started with |
| `src/shared/mcp-tools.test.ts` | The wire shape of every `inputSchema`; names against `MCP_TOOL_NAMES`; `start_discussion`'s three refinements; the wait and round bounds; `chatUrl` / `parseChatUrl`; the `z.infer` type test; that the module imports `zod` and nothing else. Plus `describe('MCP_PROMPTS and renderPrompt')` (WP-15): the argument table in MCP's own shape rather than as a JSON Schema, the three sentences the expansion exists to say, a comma-separated `agents` becoming the array the tool takes, `chat` continuing a discussion, and the refusals `start_discussion` would give in the same words |
| `src/shared/mcp-discovery.test.ts` | Every way the discovery file can be wrong; `userDataDirFor` with and without the override; that the module stays pure |
| `src/main/mcp-endpoint/guards.test.ts` | Each guard as a sentence, without a socket: the path claim; any `Origin`; a foreign `Host`, loopback on another port, a missing one; the bearer in every malformed spelling; the order the three run in; a repeated header; the body cap at, one over, and not-JSON |
| `src/main/mcp-endpoint/server.test.ts` | A real listener driven by the SDK `Client`: `tools/list`; a call arriving with its arguments, `ctx`, `handlers` and `client`; `isError` for a failed outcome and for a tool that throws; a protocol error for an unknown tool; progress relayed in order and absent when unasked; `signal` aborting when a raw `fetch` is abandoned and when a client closes mid-call; `close()` aborting in-flight calls; the five refusals by raw request; `ToolOutcome` → `CallToolResult` without a socket |
| `src/main/mcp-endpoint/no-electron.test.ts` | The import closure of `src/main/mcp-endpoint/` reaches `app-context.ts` and `chat-runner.ts` and contains no `electron`, in any of its spellings (CLAUDE.md rule 5) |
| `src/main/launch-args.test.ts` | Both argv shapes, the accepted and rejected link forms, and the scheme pin (WP-8) |
| `src/renderer/src/stores/chats.test.ts` | `describe('ui.open-chat')`: select, ignore, hold until the list lands, drop (WP-8) |
| `e2e/launch.spec.ts` | `--background` yields no window and `activate` still opens one; a link opens one; two `WITENA_USER_DATA` directories coexist (WP-8) |
| `src/main/mcp-endpoint/tools.test.ts` | All six against a **real** backend (real `AppContext`, real `buildHandlers()`, real `ChatRunner`, `MockLanguageModelV4`): each tool's happy path; name resolution by id, by name and by case, ambiguous and unknown; an executor refused; `busy` on a chat that is still talking; both caps; a relative and a missing `workdir` (and that neither left a chat behind); a `chat.send` that fails releasing the watcher; `wait_for_discussion` on an idle chat with and without a conclusion, and giving up at the deadline; `get_discussion` both details and `afterMessageId`; `stop_discussion` running and idle; `not_found` surfacing as `not_found`; and, for every tool, that garbage arguments are refused rather than thrown. In `afterEach`: the bus ends with as many listeners as it started with |
| `src/main/mcp-endpoint/contract.test.ts` | The two halves together (WP-6), which no other file does: a real `AppContext`, the real `buildHandlers()`, the real `ChatRunner` against a `MockLanguageModelV4`, and `createMcpEndpoint({ ctx, handlers, token })` **without** `tools` — so the registry is the real `createTools()` — on an ephemeral port, driven by the SDK `Client`. `tools/list`; `list_agents` → `start_discussion({ agents: ['Ada', 'lin'] })` → `concluded` with the mock's text, no `[AGREED]` on either half of the result → `list_chats` finds the chat under the question's first line → `get_discussion` `transcript` has both names and the `context` that was sent. Then the status mapping of "Frozen contracts" row by row, each through the socket: `concluded`; `rounds: 1` → `ended` with one position per member; a wait in flight when `stop_discussion` lands → `stopped`; a throwing provider → `error`; an emitted `permission.requested` → `needs-attention` with the run still live; `maxWaitSeconds: MIN_WAIT_SECONDS` → `running` and the next `wait_for_discussion` → the conclusion. Plus a validation refusal arriving as `isError` `"validation: …"` with no `structuredContent`, and 401 / 403 from the real door. The counting bus rides along in `afterEach` |
| `src/main/integrations/ide-clients.test.ts` | The real implementation with **no CLI ever run** (WP-11): `newestVersionFirst` against both directions a string sort gets wrong; `claudeCodeDirs` over a temporary home and over a machine that never installed it; `detect` confirming with `--version` and reading three kinds of no; the exact argument vector of each of the six commands, with a launcher path containing a space kept as one argument; `claude mcp get`'s exit 1 read as "not registered"; Codex's entry found by name among plugin-injected servers; both parsers degrading to `null` on output they do not recognise; a CLI that refused surfacing as `internal` with its own words; and a missing binary carrying `integrations_client_not_installed` |
| `src/main/handlers/integrations.test.ts` | The policy over a stateful fake `IdeClients` that records every call in order (WP-11): a machine with neither client, asked once each and no more; installed separated from connected; a registration naming another installation flagged `stale`, and never flagged in a build with no launcher; `enabled` and `listening` disagreeing honestly; `connect` opening the endpoint **before** it registers, leaving an already-correct client completely alone, and repairing a stale one by removing and adding; both refusals touching neither the CLI nor the settings row; `disconnect` idempotent and leaving the endpoint up; and the default test context — `absentIdeClients()` — answering as the Node host does |
| `src/main/mcp-endpoint/host.test.ts` | The host as a separate process meets it (WP-7): nothing listens until asked; `start()` publishes a port, a 32-byte token and this pid, mode `0600`; the published port answers `tools/list` through the SDK client with the token and `401` without; a fresh token on every start; `stop()` takes the file and the port away; both calls idempotent, and two overlapping `start()`s leave one socket; a discovery file naming another pid is neither deleted nor trusted; the injected `randomToken` / `pid` |
| `src/main/handlers/settings.test.ts` | The row and the toggle (WP-7): the defaults, `mcpEndpoint.enabled` false, a row written before S10.3 gaining the group switched off, a patch merging rather than replacing, every malformed `mcpEndpoint` patch refused *before* the write, a context with no host storing the switch anyway, a fake host started and stopped as the switch is thrown, a patch about something else leaving it alone, and a `start()` that throws still storing the row |
| `src/main/mcp-endpoint/transcript.test.ts` | The rendering, from hand-built rows: the header shape, the conclusion mark, a tool call on one line and a failed one marked, reasoning and `[AGREED]` absent, `passed` / `skipped` / `error` in the header, a notice as its key, an unnamed agent as its id, and an empty transcript saying so |
| `src/mcp-shim/connect.test.ts` | The lookup against real temporary directories: the path rule; a good file; a missing one, a future version, a non-object and a dead pid all as "no endpoint"; `SingletonLock` as the liveness hint; each of the three refusals including which one a timed-out launch produces; connecting with the file's numbers and the IDE's name; the file read once and reused; the re-read after a `401` and after an `ECONNREFUSED`; a non-stale failure neither retried nor cached; staleness recognised in both spellings and not confused with a 403 or a 413; and `openIfRunning` (WP-15) — null with no file and with an app that wrote none, never launching in either case, connecting with the file's numbers when there is one, ignoring the cache, and reporting a refused socket as "nothing there" on stderr |
| `src/mcp-shim/launch.test.ts` | `bundlePathFor` on a real bundle path, one with spaces, a nested bundle and four non-bundles; the `open` argument vector with and without the `WITENA_USER_DATA` override; `launch` with an injected `spawn` and clock — detached and unreferenced, polling until the file appears, giving up at the deadline, and not waiting at all when `open` cannot be run |
| `src/mcp-shim/no-electron.test.ts` | The shim's closure reaches `index.ts`, `server.ts`, `connect.ts`, `launch.ts` and WP-1's two shared modules, imports no `electron`, no `better-sqlite3` and nothing under `src/main/`, and no package outside the MCP SDK and zod |
| `src/main/mcp-endpoint/tools.test.ts` — `describe('provenance (S10.4)')` | The calling client reaching the stored `OriginPart`; `mcp` for a caller that sent no header; a badly chosen name arriving sanitised; and the same mark on a question sent into an existing chat (WP-13) |
| `src/main/handlers/chats.test.ts` — `describe('sanitizeOriginClient (S10.4)')` | The cleaning rules one by one: ordinary names, whitespace, newline, `\r`, tab, ANSI escape, NUL, bidi override, zero-width space, a non-Latin name kept; the cap, and that the cap does not leave a trailing space; `null` for empty, whitespace-only, control-only and every non-string (WP-13) |
| `src/main/orchestration/chat-runner.test.ts` — `describe('provenance (S10.4)')` | The flag stored first and on the user message alone; a typed message left unmarked; the event sequence, mentions, round and finish reason unchanged; the client name absent from the prompt (WP-13) |
| `src/main/agents/history.test.ts` | Two cases for the converter: a question with and without the flag producing byte-identical `ModelMessage`s, and a message that is nothing but the flag dropped (WP-13) |
| `src/renderer/src/components/chat/transcript-rows.test.ts` — `describe('originClient (S10.4)')` | The row carrying the client name; the flag read wherever it sits; an empty name treated as none; the first of two winning; the two flag parts not confused (WP-13) |
| `src/mcp-shim/shim.spawn.test.ts` | The **built** `out/mcp-shim/witena-mcp.cjs` (built in `beforeAll`), spawned with plain `node` and driven by the SDK's stdio client against a WP-4 endpoint with a stub registry: `tools/list` with no file and no app; a forwarded call carrying the token and `CLIENT_HEADER`; progress relayed across both hops in order; cancellation reaching the endpoint's `signal`; a failed `ToolOutcome` passed through; the switched-off and not-running refusals; the stale-file re-read. WP-15 added a whole Claude Code session start — `tools/list`, `prompts/list`, `resources/list` and `resources/templates/list` at once, with no app and no discovery file, answered in well under the client's budget and with the endpoint untouched — plus a `prompts/get` expanded out of the bundled `@shared/mcp-tools`, and a forwarded `resources/list` / `resources/read` proving the relay crosses both hops |
| `src/main/packaging.test.ts` | The bundle's half of WP-9, over `electron-builder.yml` and `build/witena-mcp` as text: both `extraResources` destinations (`mcp/witena-mcp.cjs`, `bin/witena-mcp`), the `protocols` entry, the launcher's shebang, its `export ELECTRON_RUN_AS_NODE` and `exec` line, the two paths it derives, `productName === 'Witena'` (the executable the `exec` line names), and its **mode in the git index** — 755 there, because that is the mode a fresh clone and therefore the packaged bundle gets. Owned by [`../packaging/implement.md`](../packaging/implement.md) |
| `e2e/packaged.spec.ts` | WP-9 against the shipped bundle: `Contents/Resources/bin/witena-mcp` exists and is executable, the shim is beside it at `mcp/witena-mcp.cjs`, and the launcher spawned the way a client spawns it answers `initialize` with `serverInfo.name === MCP_SERVER_NAME` and `tools/list` with the six names. The offline half on purpose — see [`backend.md`](./backend.md), "The bundled launcher" |
| `src/mcp-shim/index.test.ts` | The shim's handlers over `InMemoryTransport.createLinkedPair()`, against a connector whose `open()` **throws** (WP-15): so the no-launch rule fails by name rather than by timing out. The three capabilities and the absence of `subscribe` / `listChanged`; `prompts/list` and `prompts/get` answered with the connector untouched, including the comma-separated `agents` and the two refusals; `resources/list` empty when `openIfRunning` finds nothing and forwarded — with its `cursor` — when it does; `resources/read` forwarded, and refused with `RESOURCE_UNAVAILABLE_TEXT` when nothing is listening; an empty `resources/templates/list`; and `tools/call` still taking the launching path |
| `src/main/mcp-endpoint/contract.test.ts` — `describe('the parts of MCP beyond tools')` | The same three methods through the real socket and the real backend (WP-15): the capabilities; the listing in `chats.list`'s own order, capped at twenty, with no `nextCursor`; a read of a finished discussion byte-identical to `get_discussion`'s `markdown` and free of `[AGREED]`; a chat nobody has spoken in reading as its heading alone; a bad uri and a missing chat as two different errors; `prompts/list` and an expansion carrying the question, and a refusal that starts nothing |
| `e2e/mcp-endpoint.spec.ts` | The two halves with **nothing stood in for** (WP-10): the built app on a temporary `userData`, the switch thrown through `settings.update` from inside the page, and the built shim spawned with plain `node` against the same directory. The discovery file appears within the poll; `tools/list` crosses the stdio hop; `list_chats` finds a chat seeded through the backend client, with its `witena://chat/<id>` and its member; a `start_discussion` with `maxWaitSeconds: 5` on a chat whose provider is a closed port puts the question in the open window's transcript (any status is accepted — the message is the claim); and, with the switch off, a fresh shim answers `SHIM_ERROR_TEXT['endpoint-off']` |

## Known limitations and TODOs

Listed in STEPS.md S10.7's backlog bullet, plus one this feature has to carry
until somebody runs it by hand:

- **Lazy launch has never run in one piece** (WP-9). The launcher, `launch.ts`,
  `--background` and the discovery file are each tested; "a tool call wakes a
  quit Witena" is not, because reproducing it means a second signed copy of the
  app with a fresh `WITENA_USER_DATA` and therefore the Keychain prompt WP-0a
  measured. See [`backend.md`](./backend.md), "The bundled launcher".
