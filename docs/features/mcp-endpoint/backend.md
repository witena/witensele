# mcp-endpoint — Backend

> Built. Every surface below has landed; the one thing S10.5 named and did not
> build is the per-committee Claude Code subagent generator, which owns no file
> here. WP-16 added no surface at all, only documentation. Surface by work
> package (`tasks.md`):

| Surface | Package |
|---|---|
| `src/shared/mcp-tools.ts`, `src/shared/mcp-discovery.ts` | WP-1 `[x]` (2026-09-20) |
| `src/main/mcp-endpoint/discussion.ts` — `watchDiscussion`, `readDiscussion` | WP-2 `[x]` (2026-09-20) |
| `src/main/mcp-endpoint/tools.ts`, `transcript.ts` — the discussion tools | WP-3 `[x]` (2026-09-20), `list_committees` and `committee` added by WP-14 `[x]` (2026-09-20) |
| `src/main/mcp-endpoint/server.ts`, `guards.ts`, `tool-types.ts` — transport and refusals | WP-4 `[x]` (2026-09-20) |
| `src/main/mcp-endpoint/contract.test.ts` — the two halves over a real socket (no surface of its own) | WP-6 `[x]` (2026-09-20) |
| `src/mcp-shim/` and its Vite target | WP-5 `[x]` (2026-09-20) |
| `src/main/mcp-endpoint/host.ts`, `AppSettings.mcpEndpoint` | WP-7 `[x]` (2026-09-20) |
| Single-instance lock, `--background`, `witena://`, `ui.open-chat` | WP-8 `[x]` (2026-09-20) |
| `bin/witena-mcp` and `mcp/witena-mcp.cjs` in the bundle | WP-9 `[x]` (2026-09-20) |
| `src/main/integrations/ide-clients.ts`, `integrations.*` handlers | WP-11 `[x]` (2026-09-20) |
| `OriginPart`, `ChatSendInput.origin` | WP-13 `[x]` (2026-09-20) |
| `AppSettings.mcpEndpoint` reached from the renderer by `useSettingsStore.setMcpEndpoint` — no new backend surface | WP-12 `[x]` (2026-09-20) |
| `src/main/mcp-endpoint/resources.ts`, `MCP_PROMPTS` / `renderPrompt`, `src/mcp-shim/server.ts` | WP-15 `[x]` (2026-09-20) |

Nothing under `src/main/mcp-endpoint/` or `src/mcp-shim/` imports electron; a
closure test in each enforces it (rule 5). The shim's is stricter still: no
`better-sqlite3`, nothing under `src/main/`, and no package outside the MCP SDK
and zod.

## What exists today (WP-1)

Two modules in `src/shared/`, no main-process code yet, no database table, no
handler and no IPC method. `implement.md` describes what they export and why;
this file records what a later package has to know about them.

| Module | Imports | Notes for the packages that build on it |
|---|---|---|
| `mcp-tools.ts` | `zod` only | Bundled into the shim, so anything it imported would be bundled too. A test asserts the import list is exactly `['zod']` — a package that needs a type from `types.ts` here should import it in *its own* module instead |
| `mcp-discovery.ts` | `./version` only | Pure: no `node:path`, so the host (WP-7) and the shim (WP-5) join `DISCOVERY_FILE` onto `userDataDirFor(...)` themselves |

Pitfalls a later package would otherwise hit:

- **zod 4's `.refine()` returns the same `ZodObject`**, which is why
  `start_discussion` can carry three cross-field rules and still live in a map
  typed `{ [N in McpToolName]: z.ZodObject<z.ZodRawShape> }`. `z.toJSONSchema`
  silently drops the refinements, so WP-3 must `.parse` — validating against the
  published JSON Schema alone would let `{ chatId, agents }` through.
- **Refinements run in order and `safeParse` reports them together**, so the
  "exactly one of `chatId` / `agents`" message is the one a caller sees first.
  WP-3 passes zod's message through unchanged as its `validation` text.
- **`parseChatUrl` is strict by design**: a trailing slash, a query string, a
  fragment, an extra path segment or a non-canonical uuid all give `null`. WP-8
  gets whatever the operating system hands `open-url`; if that turns out to
  differ (a trailing slash, percent-encoding), that is a contract question for
  the integration branch, not a quiet loosening here.
- **`MAX_WAIT_SECONDS` is 600 but no client waits that long.** The cap is the
  tool's, not the client's; WP-3 must still return by the deadline it was given.
- **`DEFAULT_WAIT_SECONDS` is an assumption** (Codex's ~60 s tool timeout) until
  WP-0b measures it. Changing the number is a one-line change here and touches
  nothing else.

## Discussion watcher (WP-2)

`src/main/mcp-endpoint/discussion.ts`. No new table, no new handler, no IPC
method: it is a reader over the existing `EventBus` and `HandlerMap`, and the
only main-process module it imports is the *type* of each (`../app-context`,
`../handlers/types`), so the closure test WP-4 adds has nothing to complain
about.

| Export | What it is |
|---|---|
| `watchDiscussion(ctx, handlers, options)` | `{ result, cancel() }`. Subscribes synchronously, settles once, releases everything on every path |
| `readDiscussion(ctx, handlers, { chatId, afterSeq })` | The same `DiscussionResult` without waiting |
| `loadTranscript(ctx, handlers, chatId)` | The whole chat, oldest first, paged through `messages.list` |
| `DiscussionProgress` | `(update: { message: string; round?: number }) => void` |

Handlers it calls: `chats.get` (existence), `messages.list`, `agents.list`,
`chats.members.list`, `messages.usageSummary`. Nothing reaches a repository.

Pitfalls for the packages that build on it:

- **`afterSeq` is a position, and positions are `seq`s.** `seq` is internal to
  `MessageRepository` and never crosses IPC, so this module derives it: `seq` is
  assigned as `max(seq) + 1` inside the insert transaction and no message row is
  ever deleted on its own, therefore the *k*-th message of a chat in ascending
  order has `seq === k`. WP-3 gets both numbers it needs from `loadTranscript`:
  the `afterSeq` of a message about to be sent is the array's `length`, and
  `wait_for_discussion`'s "the `seq` of the last user message minus one" is that
  message's index. A test asserts `transcript.length + 1 === repos.messages.nextSeq(chatId)`.
- **`deadlineMs` is an absolute epoch-millisecond timestamp**, not a duration:
  `Date.now() + maxWaitSeconds * 1000` at the call site. A deadline already in
  the past is legal and answers immediately.
- **`result` never rejects.** WP-3 calls `cancel()` when `chat.send` throws and
  does not await the result; a rejection there would be an unhandled one. A read
  that fails while building the result is reported *inside* the result instead
  (`status: 'error'`, or `running` when the caller had already given up).
  `readDiscussion` is the opposite and does throw — a `get_discussion` on a chat
  id the model invented must surface as `not_found`, which is why it asks
  `chats.get` first: `messages.list` answers an unknown chat with an empty page.
- **Aborting the wait never stops the run.** `signal` belongs to the MCP request;
  the discussion is an ordinary chat that keeps going in the window, and
  `stop_discussion` is the tool that ends it.
- **The watcher does not depend on event ordering.** It settles on
  `run.finished` and then *re-reads the transcript*, and every message row is
  written by the awaited turn before the run can finish, so no assumption about
  `message.updated` arriving before `run.finished` is made or needed. The
  "concludes when the group agrees" test is what pins it: a conclusion that was
  not yet committed would come back as `ended`.
- **`usage` is chat-wide**, because `messages.usageSummary` prices a whole chat.
  For a chat the endpoint created they are the same number; for a continued one
  the total is still the honest answer. Omitted when nothing was spent.
- **Text is read the way the renderer reads it**: `text` parts only, and
  `stripTrailingMarkers` — `[AGREED]` is how the group talks to the runner, not
  something an IDE agent should be handed.

## The HTTP endpoint (WP-4)

`createMcpEndpoint({ ctx, handlers, token, tools? }) → { handle, close }`, plus
`isMcpPath`, `MAX_BODY_BYTES` and the guard functions from `guards.ts`. It opens
no socket of its own: `handle(req, res)` is a `node:http` request handler, and
WP-7's host is what listens. `implement.md` describes the design; this section is
what the packages downstream of it have to know.

**What WP-3 must do.** `tool-types.ts` holds `ToolCallContext`, `ToolOutcome`
and `ToolRegistry` exactly as "Frozen contracts" writes them, because WP-4 needed
the types before `tools.ts` existed. When `tools.ts` lands it (1) re-exports the
three types from `./tool-types`, so the contract reads where it says it reads,
and (2) replaces the body of `missingToolRegistry()` in `server.ts` with
`return createTools()`. That function throws a sentence naming both steps today.
Two more things the registry is held to: **return an object from `structured`**
(MCP's `structuredContent` is a JSON object or nothing, and a non-object is
dropped rather than wrapped in an invented key), and **do not throw** — a throw is
caught and rendered as `internal: <message>`, which hides the bug rather than
reporting it.

**How cancellation reaches `signal` (WP-5 especially).** The endpoint is
stateless, so `notifications/cancelled` arrives as its own HTTP request and
reaches a `Server` instance that never heard of the call it names: it cannot
abort it. A running tool is aborted by the caller **dropping its HTTP request** —
`res` closes, the endpoint closes that request's transport, and the SDK's
`Protocol._onclose` aborts every in-flight handler. So the shim cancels a
forwarded call by closing (or by scoping per call) its
`StreamableHTTPClientTransport`, not by relaying a notification. The SDK client
has one `AbortController` per *transport*, not per request, so a per-call
transport is the cheaper of the two shapes.

**How progress is relayed.** `ToolCallContext.progress` exists only when the
`tools/call` carried `_meta.progressToken` — with the SDK client, that means the
caller passed `onprogress`. Each update becomes one `notifications/progress` on
the request's own SSE stream, with `progress` a counter that increases by one per
update (the spec requires it to increase) and `message` the update's text
verbatim. MCP's notification has no field for a round, so the round rides in the
message WP-2 writes; a client that wants it reads the sentence. A send that fails
because the caller went away is swallowed — the run keeps going.

**How `Host` is checked against the port.** `req.socket.localPort`, not a port
passed in at construction: WP-7's host binds `127.0.0.1:0` and only learns its
port after `listen` resolves. Nothing has to tell the endpoint what port it is
on, and a request that reached port B claiming `Host: 127.0.0.1:A` is refused,
which is the case the check exists for.

**Two SDK type mismatches, both cast with a comment.**
`StreamableHTTPServerTransport` declares `onclose: (() => void) | undefined`
where `Transport` declares `onclose?: () => void`, so under
`exactOptionalPropertyTypes` the SDK's class does not satisfy the SDK's own
interface — the mirror of what `src/main/mcp/manager.ts` already documents for
the client transport. For the same reason the documented stateless spelling
`{ sessionIdGenerator: undefined }` does not type-check; the key is omitted
instead, which is the identical property read at runtime.

**The closure test is a sibling, not a reuse.**
`src/main/mcp-endpoint/no-electron.test.ts` re-states the scanner that
`src/server/no-electron.test.ts` exports. Importing one `*.test.ts` from another
re-runs its `describe` blocks inside the importer, so the server's suite would be
collected and reported twice; thirty lines of directory walk is the cheaper
price, and it keeps the two guards independent.

## Launch, lock and deep link (WP-8)

The part of the endpoint that lives in `src/main/index.ts` rather than under
`src/main/mcp-endpoint/`: how the app comes up when a coding agent rather than a
person starts it, and how a `witena://chat/<id>` link reaches the window.

| Module | What it owns |
|---|---|
| `src/main/launch-args.ts` | `parseLaunchArgs(argv) → { background, openChatId }`, `BACKGROUND_FLAG`, `CHAT_URL_SCHEME`. Pure, no electron import, unit-tested |
| `src/main/index.ts` | The single-instance lock, the `--background` branch at ready, `open-url`, `second-instance`, `setAsDefaultProtocolClient`, and the one emit of `ui.open-chat` |
| `electron-builder.yml` | `protocols: [{ name: Witena chat link, schemes: [witena] }]` — see [`../packaging/backend.md`](../packaging/backend.md) |

### The order at the top of `index.ts`

1. `app.setName(APP_NAME)` — before anything reads `userData`.
2. `applyUserDataOverride()` — `WITENA_USER_DATA`, as before.
3. `parseLaunchArgs(process.argv)`.
4. `app.requestSingleInstanceLock()`, and `app.quit()` when it is `false`.
5. The `second-instance` and `open-url` listeners, both **before `ready`**.

Steps 2 and 4 are in that order on purpose. WP-0a measured that the lock is
keyed by `userData` (`context.md`, "What the spike found", item 3): two
instances with different `WITENA_USER_DATA` both get `true` and run side by
side, which is what lets `e2e/launch.spec.ts` have two apps alive at once and
what has always let the Playwright specs use temporary directories. Asking for
the lock before the override would key every launch off the real directory and
turn every parallel spec into a lost lock.

The same measurement is why the losing instance is only ever `app.quit()`ed: it
**never reaches `ready`**, so no `whenReady` body, no `before-quit` cleanup and
no listener can be relied on to run in it. `whenReady` re-checks the flag
anyway, which costs one comparison and makes the guarantee this file's rather
than a platform note's.

### The deep link, and why it is emitted late

`ui.open-chat` (`src/shared/events.ts`) is the only event whose subject is the
interface rather than the data. It exists because the alternative is a second
IPC channel for navigation, and because rule 6 says the renderer hears from the
backend through `BackendClient.subscribe` and nothing else.

Two pieces of timing decide where the code sits:

- **`open-url` can fire before `ready`** on a cold launch, which is the case
  that matters most — the user clicked a link and the app was not running. The
  listener is registered at module scope and, with no bus to emit on yet, parks
  the id in `pendingOpenChatId`; the ready handler drains it last, after the
  transport is registered.
- **`forwardEvents` sends to the windows that exist at the moment of the emit**,
  and a window created one line earlier has no renderer. So the emit waits for
  `webContents.did-finish-load` when the window is still loading. The renderer
  starts its subscription before the first render, so that is late enough for
  the event — but not for `chats.list`, which is why the store holds the id
  until its first load answers (see [frontend.md](./frontend.md)).

**Nothing in the main process checks that the chat exists.** It would have to
reach past the handlers to find out, and the window answers the question better:
it ignores an id it does not have, which is also the right answer for a chat
deleted between the link being written and being clicked. `parseChatUrl` proves
the link's shape and nothing more.

`setAsDefaultProtocolClient(CHAT_URL_SCHEME)` runs **in packaged builds only**.
In development the "app" is the electron binary in `node_modules`, and claiming
the scheme would point every `witena://` link on the machine at a checkout that
moves, is deleted, or is on a different branch by the time a link is clicked.

### `--background`

`if (!launch.background) createWindow()` is the whole feature. The app comes up
with its Dock icon, its database and (once WP-7 lands) its endpoint, and no
window; the existing `activate` handler opens one when the user clicks the Dock
icon, which is the same path a user who closed the window already takes. No new
UI, and no main-process copy — rule 4 stays satisfied because there is nothing
to translate.

### Tests

| File | Covers |
|---|---|
| `src/main/launch-args.test.ts` | Both argv shapes (packaged is exactly two entries, dev has more), the flag anywhere after `argv[0]`, links accepted and rejected, `argv[0]` never read as either, and that `CHAT_URL_SCHEME` is the scheme `chatUrl` really writes |
| `e2e/launch.spec.ts` | `--background` yields zero windows and `activate` still opens one; an `open-url` on a background instance opens a window and leaves no error; two apps with different `WITENA_USER_DATA` both run |

`e2e/launch.spec.ts` does **not** assert that a second instance on the *same*
directory quits: the losing process never reaches `ready`, so driving it through
Playwright would be a race against its own teardown. WP-0a measured that case
directly instead.

## Host and the setting (WP-7)

The endpoint stops being a request handler and becomes a **door**: a socket, a
file that says where it is, and one boolean that decides whether either exists.

| Module | What it owns |
|---|---|
| `src/main/mcp-endpoint/host.ts` | `createMcpEndpointHost({ ctx, handlers, userDataDir, randomToken?, pid? })` → `{ state, start, stop }`. `node:http`, `node:fs`, `node:crypto`, `node:path`; no electron |
| `src/shared/types.ts` | `McpEndpointSettings { enabled }`, `AppSettings.mcpEndpoint` (default `{ enabled: false }`), `AppSettingsPatch.mcpEndpoint?: Partial<…>` |
| `src/main/db/repositories/settings.ts` | `mcpEndpoint` merged field by field on the read **and** on the write, like `editor` and `timeouts` |
| `src/main/handlers/settings.ts` | `assertMcpEndpointPatch`, and the live toggle: `ctx.mcpEndpoint?.start()` / `.stop()` after the row is written |
| `src/main/app-context.ts` | `AppContext.mcpEndpoint: McpEndpointHost \| null`, built when `AppContextOptions.mcpEndpoint = { handlers }` is given |
| `src/main/index.ts` | Builds `buildHandlers()` once, passes the option, starts the host when the setting says so, stops it in `before-quit` |

No new table and no new IPC method: the switch is a field of the settings row
that already exists, and `settings.get` / `settings.update` are the methods that
already carry it.

### What `start()` does, in order

1. A fresh `randomBytes(32).toString('base64url')` token — **per `start()`**, so
   stopping and starting invalidates the old one, which is exactly the property
   PLAN's decision table wanted from "a random token per launch".
2. `createMcpEndpoint({ ctx, handlers, token })` — the real tools, because
   `tools` is only passed by WP-4's own tests.
3. `createServer((req, res) => void endpoint.handle(req, res))` and
   `listen(0, '127.0.0.1')`. The host routes nothing: `handle` answers `MCP_PATH`
   and 404s the rest itself.
4. Only then the discovery file, because only then is the port knowable — which
   is also why `guards.ts` checks `Host` against `req.socket.localPort` rather
   than against a number it was told.

`stop()` is the reverse and starts with the file. It removes it **synchronously
and first**, ahead of anything awaited, because `before-quit` in
`src/main/index.ts` is a synchronous listener that cannot await: a quit is only
guaranteed to reach the first synchronous statement. Then `endpoint.close()` —
which is what ends the in-flight `wait_for_discussion` calls, by closing the
transports whose `signal` those tool calls hold — and then the socket, with
`closeAllConnections()` so a keep-alive cannot hold `close()` open.

Pitfalls for the packages that build on it:

- **`writeFileSync`'s `mode` only applies to a file it creates.** The second
  launch writes over a file that already exists, where the option is ignored, so
  the `chmodSync` after it is not belt and braces — it is the half that covers
  every run but the first.
- **`stop()` removes the discovery file only when its `pid` is ours.** A file
  naming another process is a *running* Witena on the same directory; the
  single-instance lock (WP-8) should make that impossible, but a lock is not a
  proof, and deleting somebody else's file would break a live IDE session to tidy
  up after ourselves. Unreadable, unparseable and absent are all "nothing of ours
  is there", and all leave the file exactly as found.
- **`start()` and `stop()` are serialised, not merely idempotent.** Both go
  through one promise chain, so a switch answered twice in a tick cannot leave a
  socket with nothing pointing at it. A second `start()` on a live host is a
  no-op that keeps the same port *and the same token* — a shim already holding
  one must not be invalidated by a caller that asked twice.
- **The host never reads the setting**, and `createAppContext` never starts it.
  A context that opened a port on construction is a context no test could build;
  reading the setting is `src/main/index.ts`'s job at launch and the handler's
  job on a toggle.
- **`ctx.mcpEndpoint` is `null` off the desktop**, so `ctx.mcpEndpoint?.start()`
  is a no-op in `src/server/` and in every suite. The *setting* is not
  desktop-only — the row is written wherever the handler runs — only the door is.

### The toggle, and what happens when it fails

`settings.update` stores the row and then makes the process match it. Two
decisions are worth stating because WP-11 and WP-12 both lean on them:

- It acts on the **stored** value, not on the patch, so a patch carrying an empty
  `mcpEndpoint: {}` still means "make the process match the row".
- A `start()` that throws is logged and swallowed. The row is the user's intent;
  whether a socket came up is a fact about this launch, and WP-11's
  `integrations.status` reports it from `host.state`. Rejecting would leave the
  row saying one thing and the UI — which reverts a switch on a rejected update —
  saying the other.

### In `src/main/index.ts`

Three edits, all outside the window's code path:

| Where | What |
|---|---|
| Before `createAppContext` | `const handlers = buildHandlers()`, passed both to `createAppContext({ … mcpEndpoint: { handlers } })` and to `registerIpc` — one map, so a discussion started by a coding agent goes through exactly the handlers the window goes through |
| After `registerIpc` / `forwardEvents`, **before** `if (!launch.background) createWindow()` | `if (settings.mcpEndpoint.enabled) void ctx.mcpEndpoint?.start().catch(…)` |
| `before-quit`, first | `void context?.mcpEndpoint?.stop().catch(…)`, ahead of `context.close()` |

The middle one is the load-bearing placement: `--background` (WP-8) is a launch
with **no window at all** — a coding agent's shim started it and is polling for
the discovery file — so anything hanging off `createWindow()` would be a door
that only opens when somebody is looking.

## Tools (WP-3)

`src/main/mcp-endpoint/tools.ts` (`createTools()`, plus the three contract types
re-exported from `./tool-types`) and `src/main/mcp-endpoint/transcript.ts`
(`renderTranscript`). No new table, no new handler, no IPC method: the tools are
a caller over `HandlerMap`, and `transcript.ts` is a pure renderer.

The seam WP-4 left is closed: `missingToolRegistry()` in `server.ts` is now
`defaultToolRegistry()`, whose body is `return createTools()`, so
`createMcpEndpoint({ ctx, handlers, token })` without `tools` serves the real
registry.
That, plus the re-export line at the top of `tools.ts`, is the whole of the
hand-over; nothing else in `server.ts` changed.

**Handlers each tool calls.** Nothing reaches a repository, with one deliberate
exception noted below.

| Tool | Handlers |
|---|---|
| `list_chats` | `chats.list`, `chats.members.list` (per chat), `agents.list` |
| `list_agents` | `agents.list`, `providers.list` |
| `list_committees` (WP-14) | `committees.list`, `agents.list` |
| `start_discussion` | `agents.list` (name resolution), `committees.list` (WP-14, only when `committee` was given), `chats.get` **or** `chats.create`, `messages.list` (via `loadTranscript`), `chat.send`, and everything `watchDiscussion` reads |
| `wait_for_discussion` | `chats.get`, `messages.list`, then `watchDiscussion` or `readDiscussion` |
| `get_discussion` | `chats.get`, `messages.list`, `agents.list`, and `readDiscussion` for `detail: 'conclusion'` |
| `stop_discussion` | `chats.get`, `chat.stop` |

The exception is `ctx.runners.getState(chatId)`, read by `list_chats` (the
`running` flag), by `start_discussion` (the `busy` refusal) and by
`stop_discussion` (`wasRunning`). It is not a repository: the live run state is
in memory on the context and no handler exposes it, which is the same reason
`discussion.ts` reads it.

Pitfalls for the packages that build on this one:

- **A tool never throws, and `server.ts` relies on it.** Every implementation is
  wrapped by `tool(name, …)`, which parses with `MCP_TOOL_INPUTS[name]` and turns
  anything thrown into an outcome — a `BackendFailure` keeps its
  `BackendErrorCode`, everything else is `internal` with the message and no
  stack. A new tool added outside that wrapper loses both halves.
- **`structured` is always an object.** `server.ts` drops a non-object rather
  than inventing a wrapper key, so the list tools answer `{ chats, hint }` /
  `{ agents, hint }` rather than a bare array. The three waiting tools answer the
  frozen `DiscussionResult` verbatim.
- **`busy` is the only code that is not a `BackendErrorCode`.** It is raised in
  exactly one place — `start_discussion` on a chat whose runner has live state —
  and reaches the caller as `busy: <message>` in the `isError` text.
- **`chats.create` owns the `workdir` check**, not the tool. It validates
  absolute / exists / is-a-directory *before* the row is written, so a refused
  `workdir` leaves no half-created chat, and its message already names the path.
  WP-14, which changed how the member list is built, kept that ordering:
  validation before creation, and the committee resolved before the row exists.
- **Duplicate members are folded, not refused.** A caller that names the same
  agent by name and by id meant one seat, and `setMembers` would reject the
  duplicate outright.
- **`transcript.ts` is pure and is the renderer WP-15 wants.** `resources/read`
  is specified as "`transcript.ts`'s markdown", so it calls `renderTranscript`
  with `loadTranscript`'s rows and the same `agentId → name` map; there is
  nothing else to build.
- **WP-13 passes `call.client`** into the `chat.send` in `start_discussion`
  (`origin: { client: call.client ?? 'mcp' }`). That is the only line of this
  file it needs; `ToolCallContext.client` is already threaded in by `server.ts`.

## The shim (WP-5)

`src/mcp-shim/` → `out/mcp-shim/witena-mcp.cjs`. It is a *client* of everything
above and owns no state beyond one cached discovery file, so nothing in the app
imports it and nothing in it imports the app. Three modules:

| Module | Exports | Notes |
|---|---|---|
| `index.ts` | `createShimServer`, `createProcessConnector`, `main`, `forwardTimeoutMs`, `toolErrorResult`, `logToStderr` | The bundle's entry point: it calls `main()` at the bottom of the file, so importing it starts a server |
| `connect.ts` | `createConnector`, `probeDiscovery`, `appIsRunning`, `isStaleEndpoint`, `discoveryPathFor`, `openEndpointClient`, `ShimError`, `SHIM_ERROR_TEXT` | The lookup, the one retry and the three refusals |
| `launch.ts` | `bundlePathFor`, `openArgsFor`, `launch`, `LAUNCH_TIMEOUT_MS` (20 000), `LAUNCH_POLL_MS` (250) | `open(1)`, with `spawn` and the clock injected |

### The build

`vite.mcp-shim.config.ts`, a fourth target beside electron-vite's three and
`vite.server.config.ts`. `npm run mcp-shim:build` runs it and `npm run build`
ends with it, so `out/mcp-shim/witena-mcp.cjs` exists whenever `out/main` does —
which is what WP-9's `extraResources` and WP-10's e2e both assume.

Four settings, each forced by where the file ends up:

| Setting | Why |
|---|---|
| `ssr.noExternal: true` | Vite's SSR build externalizes `node_modules` by default. The shim runs from inside a signed bundle that has none, so the SDK and zod are inlined |
| `format: 'cjs'` + `inlineDynamicImports` | One file, executed by the app's binary with `ELECTRON_RUN_AS_NODE=1`. `.cjs` needs no `package.json` beside it and no loader flag; inlining collapses the SDK's lazy imports so no sibling chunk has to be shipped |
| `external: builtinModules` (+ `node:` forms) | The runtime's, and not inlinable |
| `minify: false` | 696 kB either way once it is inside a 200 MB bundle; a stack trace that points at readable code is worth more |

### Pitfalls for the packages downstream

- **WP-9's launcher decides `process.execPath`.** `bundlePathFor` matches
  exactly `<anything>.app/Contents/MacOS/<one segment>`; anything else answers
  `null`, which is the *development* branch — the shim then never runs `open`
  and reports "Witena is not running" instead. So `bin/witena-mcp` must `exec`
  the bundle's own `Contents/MacOS/Witena` (which WP-0a confirmed is what sets
  `execPath`), not `node`, or lazy launch silently stops working while every
  other test still passes.
- **The three error texts are `SHIM_ERROR_TEXT`**, exported and asserted by
  name. WP-10 and WP-15 should match against that export rather than against a
  copy of the sentence.
- **A forwarded call gets its own `Client` and its own transport**, closed in a
  `finally`. That is not tidiness: the SDK client owns one `AbortController` per
  *transport*, and the endpoint only aborts a running tool when its HTTP request
  is dropped (WP-4), so a shared transport would make cancelling one call cancel
  all of them.
- **Only `name` and `arguments` are forwarded.** The incoming `_meta` carries
  the IDE's own progress token, which means nothing to the endpoint; the SDK
  mints this hop's token when `onprogress` is passed, and `onprogress` is passed
  only when the IDE asked for progress.
- **The forwarded request's timeout is derived from `maxWaitSeconds`**
  (`forwardTimeoutMs`, + 30 s). Without it the SDK's 60 s default would abort
  every wait longer than a minute — silently, with the discussion still running.
  A tool that ever waits on something other than `maxWaitSeconds` has to be
  added there.
- **`appIsRunning` reads `<userData>/SingletonLock`**, the symlink
  (`<host>-<pid>`) Electron keeps inside `userData` and that WP-0a found is what
  makes `requestSingleInstanceLock()` per-directory. It is used for nothing but
  choosing between two English sentences, and every way of failing to read it
  answers `false`, so WP-8 may change how the lock is taken without breaking
  anything here.
- **`open --env` is passed only when `WITENA_USER_DATA` is set.** The ordinary
  launch is the plain `open -g -j -a <bundle> --args --background` the work
  package specifies; the override is added so a harness that points the shim at
  a temporary directory does not launch an app that writes to a different one.

## The contract test (WP-6)

`src/main/mcp-endpoint/contract.test.ts` adds no surface. It is the only file
that runs the transport and the tools together — `createMcpEndpoint({ ctx,
handlers, token })` with no `tools`, so the registry is the real `createTools()`
— against a real `AppContext`, the real `buildHandlers()` and the real
`ChatRunner`, over a socket driven by the SDK `Client`. `implement.md`'s test
table lists what it asserts. Three things it established that a later package
would otherwise have to rediscover:

- **`stopped` is only ever seen by a wait that is already in flight.**
  `readDiscussion` has no row for it (`discussion.ts`, `statusFor`): an idle chat
  is read as `concluded` or `ended` whatever ended it, so `get_discussion` on a
  stopped discussion answers `ended`, and `wait_for_discussion` answers `stopped`
  only when it attached a watcher *before* `chat.stop` landed. That is the
  intended behaviour — a transcript does not record why it stopped growing — but
  it is worth saying once, because `stop_discussion`'s own answer
  (`{ chatId, url, wasRunning, hint }`) is not a `DiscussionResult` and a caller
  looking for the final status has exactly this one window.
- **`MIN_WAIT_SECONDS` is a real five seconds.** The `running` row cannot be
  faked from outside — the deadline is the tool's own timer — so one test spends
  them, with a model paced at 700 ms per chunk (about 3.5 s per turn, so two
  sequential members cannot both finish inside the budget) and a raised timeout.
  It swaps `model` for an instant one as soon as `running` comes back, because
  `createModel` is asked again for every turn; that is what keeps the file's
  whole cost around nine seconds. A second such test would be five more.
- **A run seeded through `handlers['chat.send']` is live by the time the handler
  resolves**, which is how the `stopped` and `needs-attention` rows get a
  discussion that is still going when the next MCP call arrives. Waiting for the
  watcher to subscribe is then `expect.poll` over the counting bus's listener
  count, not a sleep.

## Provenance (WP-13)

Three lines of behaviour and one new member of an open union. The shape is in
`implement.md`; this section records what the rest of the backend has to know.

### What changed outside this feature

| File | Change |
|---|---|
| `src/shared/types.ts` | `OriginPart` and `MAX_ORIGIN_CLIENT_CHARS`; `OriginPart` added to `MessagePart` |
| `src/shared/backend.ts` | `chat.send`'s input gains `origin?: { client: string }` |
| `src/main/orchestration/chat-runner.ts` | `ChatSendInput.origin`, and `originParts` putting the flag in front of the text |
| `src/main/handlers/chats.ts` | `sanitizeOriginClient` (exported for its test) and `originOf`, applied in `chat.send` |
| `src/main/agents/history.ts` | No code change — `partsToText` already ignores an unknown part — but the rule is now written down, and a test pins it |
| `src/main/mcp-endpoint/tools.ts` | `origin: { client: call.client ?? DIRECT_CLIENT }` in `startDiscussion` |

`src/shared/backend.ts` was not on WP-13's *Touches* list. It has to be: the
handler map is derived from `BackendApi`, so `origin` is not a field the endpoint
could pass without the contract declaring it. The edit is the one `chat.send`
declaration and nothing else.

### The rules a later package must not undo

- **Sanitise at the boundary, once.** `origin.client` is the only string on the
  backend surface whose text a remote party chose. `sanitizeOriginClient` is the
  single place that cleans it, and everything downstream — the runner, the row
  model, the chip — assumes it already has. A second caller of `ctx.runners.send`
  with an `origin` has to go through the handler or repeat the cleaning.
- **Sanitising is not validation.** A client that names itself badly still gets
  its discussion; it just gets no chip. Turning this into a `validation` refusal
  would fail a whole tool call over a label.
- **`mcp` is the fallback, not "no flag".** A direct HTTP caller sent no header,
  and an unmarked message would claim the user typed it.
- **The flag goes first in `parts`, and only on the user message.** The same
  position `markConclusion` uses. Nothing may assume `parts[0]` is the text: a
  reader that wants the body looks for the first `text` part. `tools.test.ts` had
  one such assertion and WP-13 corrected it.
- **The history converter must stay blind to it.** `history.test.ts` asserts the
  converted `ModelMessage`s are byte-identical with and without the flag. A
  future `partsToText` that renders unknown parts generically would break that
  test, which is what it is there for.
- **Nothing else needs to change.** The database stores `parts` as JSON with no
  per-type validation, so there is no migration and no schema edit; the server
  host (`src/server/`) carries `chat.send` through the same `HandlerMap` and
  needed no change; `transcript.ts` deliberately does not render the mark.

## End to end through the shim (WP-10)

`e2e/mcp-endpoint.spec.ts` adds no surface either. It is the first file in which
a real app and the real `out/mcp-shim/witena-mcp.cjs` meet: the app is launched
by `e2e/helpers.ts` against a temporary `userData`, the endpoint is switched on
through `settings.update` from inside the page — there is no launch-time
override, and the toggle being live is what WP-7 promised — and the shim is
spawned with the same `WITENA_USER_DATA` by the SDK's `StdioClientTransport`.
Three things it settled that a later package would otherwise have to rediscover:

- **The shim is spawned with plain `node`, never with a bundle.** That is how
  `shim.spawn.test.ts` runs it and it is a safety property, not a convenience:
  under bare `node` `bundlePathFor` answers `null`, so a shim that fails to find
  the endpoint *reports* it instead of `open`ing a second Witena on a machine
  several agents share. WP-9, whose launcher exists so that `execPath` is the
  bundle, is therefore the only package that *could* prove lazy launch — and it
  could not: see "The bundled launcher" below. Its `e2e/packaged.spec.ts` case
  proves the launcher, the binary and the shim, and stops before the `open`.
- **An unpackaged, Playwright-launched app writes `SingletonLock` into the
  overridden `userData`**, so with the switch off the shim answers
  `endpoint-off` and not `not-running`. The spec asserts that one sentence
  rather than accepting either: which of the two a user is shown decides whether
  they go looking for a switch or for an app. It is the same file WP-5's unit
  test fakes with a `symlink`, here written by Chromium because the app really
  is holding the lock on that directory (WP-8).
- **The discovery file is the handshake the spec waits on.** `settings.update`
  resolves before `listen` does, so every step that needs the door open polls
  `<userData>/mcp-endpoint.json` — it appears within a few hundred milliseconds
  of the switch and is gone again when it is thrown back, which is the whole of
  what a separate process can observe about `host.ts`.

The discussion itself needs no model: the seeded agent's provider is a closed
port, the call passes `maxWaitSeconds: MIN_WAIT_SECONDS`, and what is asserted
is that the question reached the open window's transcript — the MCP call and the
renderer meeting on one event bus. Any `status` is accepted, because which one
comes back is `discussion.ts`'s subject and is pinned by `contract.test.ts`.

## The bundled launcher (WP-9)

The last piece of the path from an IDE to a discussion, and the only one that is
not code this project runs: `build/witena-mcp`, twenty lines of POSIX `sh`, which
`electron-builder.yml` copies to `Contents/Resources/bin/witena-mcp` beside a
plain-file copy of the shim at `Contents/Resources/mcp/witena-mcp.cjs`.

| Surface | Where |
|---|---|
| `build/witena-mcp` | The launcher, committed 755. Resolves its own symlinks, walks `bin` → `Resources` → `Contents`, and `exec`s `"$binary" "$shim" "$@"` with `ELECTRON_RUN_AS_NODE=1` exported |
| `electron-builder.yml` | Two `extraResources` entries; `build/witena-mcp` → `bin/witena-mcp`, `out/mcp-shim/witena-mcp.cjs` → `mcp/witena-mcp.cjs` |
| `src/main/index.ts` | `MCP_LAUNCHER` and `mcpLauncherPath()`, beside `bundledSkillsDir()` and `bundledAntDir()` |
| `src/main/packaging.test.ts` | Both entries, the `protocols` block, the script's text and its **git index mode** |
| `e2e/packaged.spec.ts` | A fourth case: the launcher answers `initialize` and `tools/list` out of the shipped bundle |

The reasoning behind each line of the script is in
[`../packaging/backend.md`](../packaging/backend.md), "The MCP launcher"; this
section records what the rest of *this* feature has to know.

### What WP-11 takes from here

```ts
// src/main/index.ts, in the `ready` handler, next to `const handlers = buildHandlers()`
const launcherPath = mcpLauncherPath()
```

`mcpLauncherPath()` answers `process.resourcesPath/bin/witena-mcp` when
`app.isPackaged` and `null` otherwise. WP-9 computes it and logs it; **WP-11
passes it into `createAppContext` as `mcpLauncherPath`**, an
`AppContextOptions` field WP-11 adds itself. Nothing new is exported from
`app-context.ts` by WP-9, and `AppContext` gained no field — the value exists in
one place, `index.ts`, where the rule that only that file may ask electron for a
path is already true.

`null` is a first-class answer, not a missing one: a checkout has no bundle and
so no stable command to give a client. WP-11's `connect` refuses with
`validation` in that case and `status` still answers; WP-12 shows the
`node <repo>/out/mcp-shim/witena-mcp.cjs` snippet instead.

### What it proves, and the one thing it does not

Verified by hand on 2026-09-20 against `dist/mac-arm64/Witena.app` from
`npm run dist:dir` — Developer ID signed, hardened runtime — with the exact
command WP-5's *Verify* uses:

| Run | Result |
|---|---|
| `printf '<initialize>' \| …/Contents/Resources/bin/witena-mcp` | `{"result":{…,"serverInfo":{"name":"witena","version":"0.1.0"}},"jsonrpc":"2.0","id":1}`, exit 0 |
| The same from `…/My Applications/Witena.app` (a path with a space) | Identical |
| The same through a symlink to the launcher, followed by `tools/list` | Identical, plus every name in `MCP_TOOL_NAMES` |
| `lsappinfo` count for `com.witena.app` while it ran | Unchanged: no Dock tile, no LaunchServices registration |

So the launcher, `bundlePathFor`'s premise (`process.execPath` is the bundle's
binary), the hardened runtime's tolerance of run-as-node and the shim's offline
half are all proven from a real bundle.

**Lazy launch is still unproven end to end.** Every piece of it exists — the
launcher makes `execPath` the bundle, `launch.ts` builds the `open -g -j` vector
and polls, WP-8 implements `--background`, WP-7 writes the discovery file — but
no test has run them in one line, because doing so means launching a *second*
signed copy of the app with a fresh `WITENA_USER_DATA`, which is the Keychain
prompt WP-0a measured (`context.md`, "What the spike found", item 2). The place
it will finally be exercised is S10.7's README procedure, followed by hand
against the **installed** app, where the prompt does not arise.

## Integrations: the endpoint's two buttons (WP-11)

The last backend piece, and the first one a *user* touches: three methods that
answer "what is on this machine, and point one of them at me".

| Surface | Where |
|---|---|
| `IdeClientId`, `IdeClientStatus`, `IntegrationStatus`, `IDE_CLIENT_IDS` | `src/shared/types.ts` |
| `integrations.status` / `.connect` / `.disconnect` | `src/shared/backend.ts` (+ `BACKEND_METHODS`) |
| `IdeClients`, `createIdeClients`, `absentIdeClients` | `src/main/integrations/ide-clients.ts` |
| The policy — what "connected", "stale" and "connect" mean | `src/main/handlers/integrations.ts` |
| `AppContext.ideClients`, `AppContext.mcpLauncherPath` | `src/main/app-context.ts` |

Nothing new crosses a transport by hand: the preload bridge, `registerIpc` and
`src/server/http.ts` all derive their method list from `BACKEND_METHODS`, so the
three are reachable over IPC and over `POST /api/integrations.*` the moment they
are declared.

### Why the CLIs and not the two configuration files

Claude Code keeps its MCP servers in the `mcpServers` object of
`~/.claude.json`; Codex keeps them in `[mcp_servers.<name>]` of
`~/.codex/config.toml`. Writing either directly is two filesystem calls, and it
is not done, because **those files belong to somebody else**. WP-0b measured
`codex mcp add` rewriting the whole of `config.toml` and normalising unrelated
entries as it went (`120` became `120.0`; an `args = []` line disappeared), with
the Codex application holding the file open the entire time. A third party
editing that file is a corruption waiting for a race. The CLI is the interface
its author supports and the thing that gets updated when the format changes.

### The vectors, exactly as WP-0b measured them

Argument vectors, never a shell line — the launcher's path can contain spaces
(`/Applications/My Apps/Witena.app/…`) and a vector cannot be re-split.

| | Claude Code | Codex |
|---|---|---|
| installed | `claude --version` | `codex --version` |
| read | `claude mcp get witena` | `codex mcp list --json` |
| register | `claude mcp add witena --scope user -- <launcher>` | `codex mcp add witena -- <launcher>` |
| unregister | `claude mcp remove witena -s user` | `codex mcp remove witena` |

Four findings decide those four cells:

- **Claude Code has no `--json`.** `mcp get` prints a block of two-space-indented
  `Label: value` lines, so `  Command: <path>` is parsed out of it
  (`parseClaudeCommand`). Its *exit status* is the primary answer: `1` with *No
  MCP server named "witena"* means "not registered", which is a state and not a
  failure — hence `ExecFileFn` resolving for a non-zero exit instead of throwing.
- **Codex's human output masks env values** as `*****`, so only `--json` may be
  parsed. `mcp list --json` also reports servers injected by Codex plugins that
  are in no configuration file at all, so the entry is found **by name** and
  nothing is inferred from the order or the count.
- **`codex mcp add` has no scope flag** — it is always global. `claude mcp add`
  needs `--scope user`, or the registration lands in whatever directory the
  process happened to be in.
- **`claude` is a multi-call executable**, so a file being at the expected path
  is not proof that it is the CLI. `detect` confirms with `--version`.

The read costs a child process per client per call, and `claude mcp get`
health-checks the server it finds — which spawns *our* shim. That is affordable
because the shim answers `initialize` and `tools/list` offline in milliseconds
and never launches the app on that path (WP-5); it is also why a client that
answered `--version` with a failure is never asked a second question.

### Finding the binaries

Neither CLI is on the `PATH` of a packaged Electron app, and WP-0b found neither
on the *login* shell's `PATH` either. The search is the one
`src/main/providers/cli-process.ts` already does for `ant` and `gcloud` —
`resolveCliBinary`, reused rather than copied:

| Step | Claude Code | Codex |
|---|---|---|
| override | `WITENA_CLAUDE_BIN` | `WITENA_CODEX_BIN` |
| then | `PATH` | `PATH` |
| then | `~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS`, versions globbed and sorted **numerically** highest-first | `/Applications/ChatGPT.app/Contents/Resources` |
| else | `installed: false` | `installed: false` |

`newestVersionFirst` compares segment by segment as numbers, because a string
sort puts `2.1.9` above `2.1.10` and `2.1.30` above `2.1.275` — both wrong, in
opposite directions. A directory whose name is not a version sorts last rather
than being dropped.

### The policy, in the handler

```
status      → per client: detect → (if installed) registered → stale?
connect     → launcher? → installed? → settings.update(enabled: true) → repair-or-register
disconnect  → installed? → (if registered) unregister
```

| Rule | Why |
|---|---|
| `connect` enables the endpoint, through `handlers['settings.update']` and **before** it registers anything | An IDE pointed at a closed door is never what the button meant, and the toggle's side effect — storing the row *and* starting the host, idempotently — lives in that handler (WP-7). Registering first would leave a window in which the client exists and its first tool call fails |
| `enabled` and `listening` are two fields | The row is the user's intent; `ctx.mcpEndpoint?.state` is what this process is doing. `ctx.mcpEndpoint` is `null` on the Node host and in every test, so the two honestly disagree there, and one "on" would have to lie about one of them |
| `connect` repairs: a command that is not this launcher is **unregistered and registered again** | `mcp add` over an existing name is an error in both CLIs, so a repair cannot be an overwrite. Making Repair the same call as Connect means the two cannot drift |
| A client already registered with this launcher is left completely alone | Idempotence, and the same CLI error avoided |
| `disconnect` leaves the endpoint listening | Another client, or a hand-written configuration, may still be pointed at it. The switch is how the user closes the door |
| `disconnect` on a client with nothing registered resolves | "Nothing registered" is the state the caller asked for |
| `stale` is `false` whenever `launcherPath` is `null` | A checkout has nothing to compare against, and calling a hand-written `node …/witena-mcp.cjs` stale would offer a Repair that could only fail |
| `status` never rejects for a state | Not installed, not connected and endpoint-off are the three things the section exists to draw |

### The two refusals, and why they are reasons

Both are `validation` with a `ValidationReason` in `details`, so the sentence is
written in the renderer (CLAUDE.md rule #4):

| Reason | Raised when |
|---|---|
| `integrations_no_launcher` | `connect` in a build that ships none — a development checkout, the Node host. Nothing is spawned and the setting is not touched |
| `integrations_client_not_installed` | `connect` / `disconnect` for a client whose CLI is absent. Also carried by `createIdeClients`'s own binary-search failure, so a client that disappears between `detect` and the next call is still reported as the state it is in |

A CLI that ran and refused (`already exists`, a bad flag) is `internal` with the
CLI's own `stderr` quoted and bounded at 200 characters — the developer-facing
detail line beside the generic sentence, which is where text a *third party*
wrote belongs.

### On the Node host

`src/server/context.ts` passes neither option, so `mcpLauncherPath` is `null`
and `ideClients` is the real implementation finding nothing on a machine that is
not this Mac. `status` answers — `{ enabled, listening: false, launcherPath:
null, clients: [not installed, not installed] }` — and `connect` refuses with
`integrations_no_launcher`, which is the truth: a server has no local IDE to
install itself into, and PLAN.md's "Online version" serves MCP over its own
routes rather than a discovery file.

### Tests, and the rule they exist to keep

**`npm test` must never run a real `claude` or `codex` with `mcp add` or
`mcp remove`**, because those write `~/.claude.json` and `~/.codex/config.toml`,
which belong to whoever is running the suite. Three things enforce it:

- `createTestAppContext` injects `absentIdeClients()` by default, exactly as it
  injects `absentAnthropicCli()`.
- `src/main/integrations/ide-clients.test.ts` drives the real implementation
  through an **injected `execFile` that only records**, and pins the binary
  search with `WITENA_CLAUDE_BIN` / `WITENA_CODEX_BIN`, which
  `resolveCliBinary` returns without an existence check. The one case that is
  about *no binary anywhere* also empties Codex's fallback directory, because
  `/Applications/ChatGPT.app` really is there on a machine that has ChatGPT and
  the suite must not depend on whose laptop it runs on.
- `src/main/handlers/integrations.test.ts` uses a stateful fake `IdeClients` that
  records `detect:`/`registered:`/`register:`/`unregister:` calls in order — the
  only way to assert that connect does nothing when it is already right, and
  removes before adding when it is not.

## What the Integrations section asked of the backend (WP-12)

**Nothing**, and that is the point worth recording: WP-12 built Settings →
Integrations without a new method, a new field or a new event. `integrations.status`
answered every question the screen asks, and `connect` / `disconnect` answering
with the same whole `IntegrationStatus` meant no click needed a follow-up read.
The three shapes WP-11 froze were enough as frozen.

Two things the section relies on, stated here so a later change to this layer
knows they are load-bearing:

- **`clients` is always the full `IDE_CLIENT_IDS` list, in that order.** The
  section renders a card per entry without matching by id, so a handler that
  started omitting a client — rather than reporting it as `installed: false` —
  would silently drop its card.
- **`connect` returning the *post-connect* status is what keeps the switch
  honest.** It enables the endpoint before registering, and the renderer drives
  the switch from `endpoint.enabled` in that answer rather than from the settings
  row (`frontend.md`).

The one write the section makes outside `integrations.*` is the endpoint switch,
and it goes through the existing `settings.update` with
`{ patch: { mcpEndpoint: { enabled } } }` — WP-7's handler, whose side effect is
starting and stopping the host. No second method was added for it.

## Resources and the prompt (WP-15)

Tools are what an IDE agent *does* to Witena. Resources are what it can *read*,
and a prompt is what a user can invoke. Both halves were built to the shape
WP-0b measured rather than to the shape the specification suggests, because the
two clients that matter surface them by two different routes and one of them
does not surface prompts at all.

| Client | Resources | Prompts |
|---|---|---|
| Claude Code | `resources/list` on **every session start**; the user types `@witena:` and picks a chat, and the body is pasted into the conversation | `prompts/list` on every session start; `/mcp__witena__consult` |
| Codex | Lazily, mid-turn, through its own `list_mcp_resources` / `read_mcp_resource` tools when the model asks | Never asked for; the binary carries no handler at all |

So the resource must read well as prose *and* as a tool result — which is why
its body is `transcript.ts`'s markdown — and the prompt is a Claude-Code-only
extra that nothing else is allowed to depend on.

### `src/main/mcp-endpoint/resources.ts`

| Export | What it is |
|---|---|
| `listChatResources(ctx, handlers)` | The first `MAX_LISTED_CHAT_RESOURCES` (20) of `chats.list`, as `{ uri: chatUrl(id), name, title, description, mimeType }`. No `nextCursor` |
| `readChatResource(ctx, handlers, uri)` | `chats.get` + `loadTranscript` + `renderChatTranscript` → one `text` content |
| `MAX_LISTED_CHAT_RESOURCES`, `CHAT_RESOURCE_MIME` | 20 and `text/markdown` |

Reads only, through handlers only, like everything else in this directory: no
repository, no electron, and nothing that could start a run. `chats.list` is
already `updatedAt` descending, which is the order a person wants — the
discussion they had ten minutes ago is the one they are about to mention. The
cap is there because the list is a mention menu rather than an archive; a caller
that wants the older ones wants `list_chats`, which takes a query and says which
are still running.

The body is produced by `renderChatTranscript`, which was pulled out of
`tools.ts`'s `get_discussion` and is now called by both. This is the one thing a
later package must not undo: the `@`-mention body and
`get_discussion { detail: 'transcript' }` are **one document**, and a second
rendering of the same rows would be the copy that drifts — silently, and in the
half a user sees.

Two refusals, and they are different things:

| Input | Error |
|---|---|
| A uri `parseChatUrl` rejects (another scheme, an extra segment, a non-uuid) | `InvalidParams`, pointing at `resources/list` |
| A well-formed uri whose chat is not in the database | `-32002`, the specification's "resource not found" — this SDK's `ErrorCode` enum has no name for it, and `McpError` takes a plain number |

Anything else `chats.get` or `loadTranscript` raises becomes `InternalError`
with the message and no stack, exactly as the tools do with it.

### The `consult` prompt

Defined in `src/shared/mcp-tools.ts` (`MCP_PROMPT_NAMES`, `MCP_PROMPTS`,
`MCP_PROMPT_INPUTS`, `renderPrompt`) rather than here, because **the shim answers
it with no I/O at all**. The expansion is a pure function of its arguments, the
app would produce the same string, and Claude Code asks for `prompts/list` every
time a session starts — forwarding that would be a round trip for a string the
shim already has. Sharing one function is what makes "both sides expand it
identically" a fact rather than an intention.

`prompts/get` carries strings and only strings, so `agents` is a comma-separated
list that the expansion tells the model to split, and `renderPrompt` returns a
`{ ok: false, message }` rather than throwing — this module may not import the
SDK's `McpError`, and each side raises its own.

`committee?`, which S10.6 sketched, is **not** implemented. It belongs to WP-14,
the package that gives `start_discussion` a `committee` field; an argument here
that expanded into an instruction to pass one would be a prompt that teaches a
model to fail. WP-14 adds it to `CONSULT_ARGUMENTS` and to `consultText`'s
"who" clause in the same commit as the tool field.

### Which methods may launch Witena

The decision, and the reason `Connector` grew a second way in:

| Method | Connects | Launches | Why |
|---|---|---|---|
| `initialize`, `tools/list`, `prompts/list`, `prompts/get` | never | **no** | Answered out of `@shared/mcp-tools` |
| `resources/list` | only when a discovery file already names a live app | **no** | Claude Code asks on every session start; launching for it would start Witena every time a user opened an editor |
| `resources/read` | the same | **no** | A browse, not a request for work. The refusal names the switch, and a tool call — which does launch — is one step away |
| `tools/call` | yes | **yes** | The user asked the group a question |

`connector.openIfRunning(clientName)` is that second way: it probes the
discovery file itself instead of calling `open()`, so there is no window in
which a file that vanished between the probe and the connection could turn a
listing into a launch, and it **ignores the cache**, because a cached endpoint
that has since gone away would make a listing answer "running" and then fail. A
socket that refuses is logged to stderr and reported as `null` — for a listing,
"the endpoint answered badly" and "there is no endpoint" are the same thing, and
an error there would surface as a broken `@`-mention menu rather than an empty
one. A `resources/read` with nothing listening raises
`RESOURCE_UNAVAILABLE_TEXT` instead, because a read names one document and an
empty answer would be a lie; it is a JSON-RPC error rather than a tool result
because `resources/read` has no `isError` shape to put a sentence in.

Both servers now declare `{ tools: {}, resources: {}, prompts: {} }` — no
`subscribe`, no `listChanged`. The endpoint is stateless, so a request-scoped
`Server` has nobody to notify a moment later. `resources/templates/list` answers
an empty list on both sides rather than being left out: Codex asks for it
(WP-0b saw the handler in its binary), and an empty list is truthful where
`Method not found` is noise in somebody's log.

### `createShimServer` moved to `src/mcp-shim/server.ts`

`index.ts` is the bundle's entry point and its last statement connects a
`StdioServerTransport` to the real `process.stdin`, so a test that imported it
to drive a handler would start a second MCP server on the test runner's own
stdin. `index.ts` now keeps the wiring — `logToStderr`, `createProcessConnector`,
`main()`, the bootstrap — and re-exports `createShimServer`; everything that
decides what a request *means* is in `server.ts`. The Vite entry, the packaged
file name and the launcher are unchanged.

## Committees through the endpoint (WP-14)

The last step that touches Phase 9. Two additions to the contract, one new tool
over an existing handler, and **no new backend surface of its own**: no table,
no migration, no `committees.*` method, no IPC channel.

| Change | Where |
|---|---|
| `list_committees` in `MCP_TOOL_NAMES`, `MCP_TOOL_INPUTS` (`{}`) and `MCP_TOOLS` | `src/shared/mcp-tools.ts` |
| `committee?: string` on `start_discussion`, and the first refinement widened to *exactly one of `chatId` or a new group (`committee`, `agents`, or both)* | `src/shared/mcp-tools.ts` |
| `committee?` on the `consult` prompt, and its expansion | `src/shared/mcp-tools.ts` |
| `listCommittees`, `resolveCommittee`, `executorNoteFor`; `resolveAgents` now takes the agent list instead of reading it | `src/main/mcp-endpoint/tools.ts` |

This is the **one sanctioned change to "Frozen contracts"**, and it was made
here and nowhere else. Everything downstream picked it up for free: the shim
serves `tools/list` from `MCP_TOOLS`, and every test that pins the tool-name list
— `src/mcp-shim/index.test.ts`, `shim.spawn.test.ts`, `server.test.ts`,
`contract.test.ts`, `e2e/mcp-endpoint.spec.ts` — imports `MCP_TOOL_NAMES` rather
than spelling the names out, so none of them needed editing.

### Phase 9's real names, which the plan only guessed at

`tasks.md` and STEPS.md S10.5 both said their names were a guess and that Phase
9's win. They are:

| What the plan called it | What it is |
|---|---|
| "Phase 9's list handler" | `handlers['committees.list'](ctx) → Committee[]`, in `src/main/handlers/committees.ts` |
| "the committee type" | `Committee { id, name, description, memberAgentIds }` in `src/shared/types.ts`, where `memberAgentIds` is **ordered** — it is the speaking order a chat inherits |
| "what `chats.create` expects" | `ChatCreateInput.committeeId?: string` beside `memberAgentIds?: string[]`; the chat's own `Chat.committeeId` is provenance, written once at creation and never by `chats.update` |
| "the expansion" | `initialMembers()` in `src/main/handlers/chats.ts`: the committee's members in `position` order, then `memberAgentIds`, de-duplicated keeping the **first** occurrence |

No new method was needed on Phase 9's side, which S10.5's third bullet allowed
for: `committees.list` already carries `memberAgentIds`, so "what would this
committee expand to" is answerable without asking, and that is what the empty-
committee refusal is measured against.

### The rules this package added, and what may not undo them

- **The merge stays Phase 9's.** `tools.ts` resolves a name to a `Committee` and
  hands `committeeId` over; it never expands, orders or de-duplicates. A second
  merge would be a second rule to keep in step, and the one an IDE reached would
  be the copy that drifted.
- **An executor is refused in `agents` and accepted in a committee.** The rule
  was never about membership — it is that the endpoint starts no hand-off, and
  nothing here calls `chat.handoff`. A committee is the user's own group (S10.5:
  "it is the user's committee"), so it is convened as built, and the result's
  `hint` gains a sentence naming the executor and saying that nothing was handed
  off. Phase 9's one-executor rule still applies, in `chats.create`, over the
  merged list.
- **An empty committee with no extra agents is refused before a chat exists.**
  The alternative is a chat with nobody in it, created, sent to, and answered by
  no one. With `agents` beside it the call succeeds and `committeeId` is still
  recorded: the topic really was convened on that committee.
- **`list_committees` answers `{ committees, hint }`**, an object like the other
  two list tools, because `server.ts` drops a non-object `structured`.

### What was deferred, and why

S10.5's fourth bullet — the generated `~/.claude/agents/witena-<slug>.md` per
committee, `integrations.syncCommittees`, the Integrations checkbox and the
re-sync on committee create / rename / delete — is **not built**. `tasks.md`
makes it conditional on WP-0b item 4 being *confirmed*, and WP-0b could not run
it: the `claude` CLI on this machine is not logged in, so an `@`-mention of a
subagent whose `tools:` is only `mcp__witena__*` could not be exercised at all
(see `context.md`, "WP-0b clients", item 4, and "Open questions").

So nothing was written under `~/.claude/`, `src/main/integrations/` was not
touched, no `integrations.*` method was added and no locale key was added for
it. The capability is not missing — a Claude Code session reaches a committee
through `list_committees` and `start_discussion({ committee })` like any other
tool — only the `@witena-<committee>` shorthand is. S10.5 stays `[~]` with that
bullet annotated, and S10.7's backlog picks it up once the check can be run on a
logged-in machine.
