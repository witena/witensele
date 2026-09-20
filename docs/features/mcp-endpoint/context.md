# mcp-endpoint — Context

## Problem

A user who spends the day in Claude Code, Codex or another agentic coding tool
wants to ask a Witena group without leaving it: "have the architecture committee
look at this migration". Witena runs in the background, the coding agent calls it
through MCP, the group discusses, and the conclusion comes back as a tool result.
The discussion is an ordinary chat — live in the Witena window, stored,
continuable there.

## Scope

STEPS.md Phase 10, against the design in PLAN.md "Witena as an MCP server (the MCP
endpoint)". That PLAN section — its shape diagram, decision table and tool table —
is the specification; this folder does not repeat it.

- A local MCP endpoint hosted by the desktop app (`src/main/mcp-endpoint/`).
- A stdio shim shipped inside the bundle (`src/mcp-shim/`, `bin/witena-mcp`).
- Six discussion tools, later `list_committees`, resources and one prompt.
- Background launch, single-instance lock, the `witena://chat/<id>` link.
- Settings → Integrations: the switch, and one-click install into Claude Code and
  Codex. Provenance of endpoint-sent messages (`OriginPart`).

The executable breakdown — one work package per subagent, with frozen contracts
and verification commands — is [`tasks.md`](./tasks.md).

## Out of scope

| Not here | Owner |
|---|---|
| Committees themselves: data, page, new-chat dialog | STEPS.md Phase 9 and its feature folder. This feature only *calls* them (WP-14) |
| Witena as an MCP *client* | `../mcp/` |
| The endpoint on the online server (`/mcp` behind accounts) | After S8.2; backlog |
| A menu-bar item, idle-quit, MCP elicitation as a remote permission prompt | Backlog (S10.7 records them) |
| Handing off to Witena's executor from the IDE | Never: the calling agent is the executor |

## Dependencies

| Needs | From |
|---|---|
| `HandlerMap`, `AppContext`, `EventBus` | `../backend-client/`, `../server/` — the endpoint is a third transport beside IPC and HTTP |
| `run.finished`, `run.round`, `permission.requested`, `ConclusionPart` | `../orchestration/` (S5.14, S5.16) |
| Read-only workspace tools when a chat has a `workdir` | `../executor/` (S5.11) |
| Bundle layout, `extraResources`, hardened runtime | `../packaging/` |
| Committee handlers and the expansion inside `chats.create` | Phase 9, for WP-14 only |

## Decisions and trade-offs

The decision table lives in PLAN.md and is not duplicated. Decisions made *below*
PLAN's level are recorded here as work packages land.

| Decision | Alternatives considered | Why this one |
|---|---|---|
| Low-level SDK `Server` on both sides, tool inputs as zod schemas in `src/shared/mcp-tools.ts`, JSON Schema derived with `z.toJSONSchema` | `McpServer.registerTool` in the app and hand-written JSON Schema in the shim | One definition serves the shim's offline `tools/list` and the app's validation; two would drift |
| Work is cut into packages that freeze their contracts first (WP-1) | One branch per STEPS step | Packages can run in parallel in separate worktrees and each is verifiable by command |
| `start_discussion`'s cross-field rules (exactly one of `chatId` / `agents`; `title` and `workdir` only on a new chat) are zod refinements, not two tools and not fields the JSON Schema can express (WP-1) | `start_discussion` + `continue_discussion` as separate tools; `oneOf` in the JSON Schema | One tool is one decision for the calling model, and it already has the `chatId` in front of it. `oneOf` is understood unevenly by the clients that re-describe MCP tools for their own provider, whereas every client shows a tool error — so the schema lists the fields and the refusal explains the rule |
| The published `inputSchema` is `z.toJSONSchema(…, { io: 'input' })` with `$schema` removed (WP-1) | Publishing it verbatim | A dialect announcement buys a tool schema nothing, and a client that converts MCP tools into its provider's function-calling schema can reject unknown top-level keys |
| `parseChatUrl` refuses anything but exactly `witena://chat/<uuid>` — no trailing slash, query, fragment or extra segment (WP-1) | Parsing with `new URL` and reading the first path segment | The argument arrives from the operating system when a user clicks a link, so being charitable about its shape is how a wrong link becomes a wrong chat. The refusal is `null`, which WP-8 already has to handle |
| `userDataDirFor` re-derives electron's macOS path rule instead of importing anything | Passing the directory in from `src/main/index.ts` | The shim is not an Electron process and has nobody to be told by, and the endpoint's host may not import electron (rule 5). Both halves now agree by construction, including under `WITENA_USER_DATA` |
| The single-instance lock is requested **after** the `WITENA_USER_DATA` override, and losing it does nothing but `app.quit()` (WP-8) | Asking before the override; tearing down cleanly in the loser | Measured, not assumed: the lock is keyed by `userData` (see item 3 below), so asking first would key every launch off the real directory and make parallel Playwright runs fight over one lock. The loser never reaches `ready`, so there is nothing to tear down and nothing after the `quit()` may be assumed to run |
| A deep link is delivered as an event on the existing bus (`ui.open-chat`), not as a navigation IPC channel or a main-process poke at the renderer (WP-8) | A second channel; `webContents.send` straight from `index.ts` | Rule 6: the renderer hears from the backend through `BackendClient.subscribe` and nothing else. One more union member costs nothing and is testable in the renderer without electron |
| The main process does not check that the linked chat exists; the window ignores an id it does not have (WP-8) | Looking the id up in `index.ts` before emitting | `index.ts` would have to reach past the handlers to do it, and the window has the better answer anyway — it also covers a chat deleted between the link being written and being clicked. `parseChatUrl` proves the link's shape; existence is the window's question |
| `--background` is the whole of "start hidden": no window, no menu-bar item, no new UI (WP-8) | A tray icon; a launch agent | PLAN's decision table already chose this. The Dock icon and the existing `activate` handler make the app visible and quittable with zero main-process copy, which keeps rule 4 (no `t()` in main) untouched |

### Decisions made in WP-2 (the discussion watcher)

| Decision | Alternatives considered | Why this one |
|---|---|---|
| `afterSeq` is a **position** in the chat's ascending transcript, and the module derives the `seq` from it by reading the whole chat through `messages.list` | Adding `seq` to the shared `Message` type; reading `repos.messages` directly | `seq` is deliberately internal to the repository and never crosses IPC, and the endpoint reads through handlers so it can be mounted on the server host later. `seq` is dense — `max(seq) + 1` inside the insert transaction, and no message row is ever deleted on its own — so the two are the same number, and a test pins that against `nextSeq` |
| `watchDiscussion`'s `result` never rejects; `readDiscussion` does | Both throwing; both tolerant | They have different callers. WP-3 calls `cancel()` when `chat.send` throws and never awaits the result, so a rejection there would be an unhandled one; `get_discussion` on a chat id a model invented has to come back as `not_found` rather than as an empty discussion |
| `deadlineMs` is an absolute epoch-millisecond timestamp | A duration in milliseconds or seconds | The caller's budget starts when the tool call arrives, not when the subscription is made, and "a deadline that has already passed" is then a legal input with an obvious meaning instead of a negative duration |
| The result is re-read from the transcript after `run.finished`, never assembled from the events themselves | Accumulating messages from `message.updated` while waiting | Every row is written by the awaited turn before the run can finish, so the store is both complete and authoritative — and the same function then serves `get_discussion`, which has no events to accumulate. It also means the watcher depends on no ordering between `message.updated` and `run.finished` |
| `positions` are each member's last `done` message of the *discussion*, not of the final round | The final round only (STEPS.md's first wording) | A member that was silent in the last round still has a position, and returning nothing for it would read as agreement. Executors are skipped: they write files rather than positions |

### The HTTP endpoint and its guards (WP-4)

| Decision | Alternatives considered | Why this one |
|---|---|---|
| Any `Origin` header at all is a 403 — the allowed set is empty, never a list | An allowlist of origins; the SDK transport's own `enableDnsRebindingProtection` with `allowedOrigins` | Nothing that legitimately calls this endpoint is a browser, and a list is a thing that gets widened by accident. The SDK's option would also put the check *inside* the transport, after a body has been read |
| `Host` is checked against `req.socket.localPort`, not against a port passed in at construction | Passing the port into `createMcpEndpoint` | The host listens on `127.0.0.1:0` and learns its port only once `listen` resolves, so a constructor argument would either be wrong or force a two-phase build. The socket always knows, and "the port this request actually arrived on" is exactly what the rebinding check is about |
| The endpoint reads the request body itself, capped at 8 MiB, and hands it to the transport as `parsedBody` | Letting the SDK read the body and capping on `content-length` | `content-length` is what the caller *claims*. A running total is the only cap that holds for a chunked body, and `parsedBody` is the SDK's documented way to pass a body somebody else has consumed |
| A refusal is a JSON-RPC error object (`{ jsonrpc, error: { code, message }, id: null }`) with a truthful HTTP status | The `{ ok: false, error }` envelope `src/server/http.ts` uses; an empty body | The caller is an MCP client, so a JSON-RPC error is the one body it already knows how to read, and it is what the SDK answers its own transport-level refusals with. The status still carries weight: the shim keys its "re-read the discovery file" retry on 401 |
| Cancellation reaches a running tool through the **socket**, not through `notifications/cancelled` | A cross-request map of `requestId` → `AbortController`, so a later POST could cancel an earlier one | Stateless means the cancellation notification lands on a *different* `Server` instance, which has never heard of the request it names. Such a map would have to key on ids that two shim processes both start at 1, and cancelling the wrong discussion is worse than not cancelling at all. Abandoning the HTTP request already aborts the handler, through the SDK's own `Protocol._onclose` |
| `ToolCallContext` / `ToolOutcome` / `ToolRegistry` live in `tool-types.ts` rather than in `tools.ts` | Waiting for WP-3; a temporary private copy of the three types inside `server.ts` | WP-3 and WP-4 are written in parallel and the transport needs the *types* before the implementation exists. One module holding three declarations is the smallest thing that lets both compile, and WP-3 re-exports them from `tools.ts` so the frozen contract still reads as written |

### Decisions made in WP-3 (the tools)

| Decision | Alternatives considered | Why this one |
|---|---|---|
| One wrapper (`tool(name, impl)`) parses with `MCP_TOOL_INPUTS[name]` and converts every throw into a `ToolOutcome`, so no implementation does either | A parse and a try/catch inside each of the six | The two rules the transport depends on — never throw, always validate — become structural instead of six things to remember, and a seventh tool cannot forget them |
| zod's message is passed through as the `validation` text, with the field path prefixed and several issues joined | Rewriting each refusal in the tool's own words | The schema's messages were written for this reader (`mcp-tools.ts`), and a second wording would be a second place to keep the rule. Issues are joined rather than truncated because zod reports the cross-field refinements together, and a caller handed one of three would fix one of three |
| `chats.create` owns the `workdir` check; the tool passes the path through | Re-checking absolute / exists in the tool before creating | The handler validates before it writes the row, so a refusal leaves no half-created chat, and its message already names the path. A second check would be a second filesystem race with a worse message |
| Agent names resolve **id first, then a case-insensitive exact name**, and every refusal lists the candidates | Fuzzy matching; names only; ids only | The caller has just been handed the list by `list_agents`, so a near-match is far likelier to be a different agent than a typo. A model told only "unknown agent" can do nothing but guess; one handed the list corrects itself in the next call |
| `get_discussion { detail: 'conclusion' }` reads from the chat's **last user message** when no `afterMessageId` is given — the same window `wait_for_discussion` uses | Always the whole chat | The two tools then agree on a finished chat, which is exactly what `get_discussion`'s description promises ("the same result shape the waiting tools return, as it stands right now"). `detail: 'transcript'` still defaults to the whole chat, because that is what "the whole discussion as markdown" means |
| `stop_discussion` answers `{ chatId, url, wasRunning, hint }` rather than a `DiscussionResult` | Reading the result back after stopping | The turns are still unwinding when `chat.stop` returns, so a result read there would describe a discussion mid-abort. `get_discussion` a moment later is the honest way to see what was said |
| The list tools answer `{ chats, hint }` / `{ agents, hint }` | A bare array as `structured` | MCP's `structuredContent` is a JSON object or nothing, and WP-4 drops a non-object rather than inventing a wrapper key. The `hint` then means the same thing in all six tools: the sentence the text block ends with |
| `list_chats` filters over titles and member names in the tool | Reusing the `chats.search` handler | `chats.search` also searches message bodies and returns ids. A list whose membership changed because a word appeared inside somebody's message is a surprising thing to give a model |
| `transcript.ts` is a second renderer, not a reuse of the renderer's `transcript-rows.ts` | Sharing one row model | One produces a React model with streaming states, avatars and collapsible reasoning; the other produces text for a model that wants the arguments. They share the rows and nothing else |

### The shim (WP-5)

| Decision | Alternatives considered | Why this one |
|---|---|---|
| One SDK `Client` and one `StreamableHTTPClientTransport` **per forwarded call**, closed in a `finally` | One long-lived client for the process; relaying `notifications/cancelled` | WP-4's finding decides it: the endpoint is stateless, so a cancellation notification reaches a `Server` that never heard of the call, and the only thing that aborts a running tool is the caller dropping its HTTP request. The SDK client owns one `AbortController` per *transport*, so a shared one would make cancelling any call cancel all of them |
| The discovery file is cached for the life of the process and invalidated on `401` / `ECONNREFUSED` | Reading it on every `tools/call`; watching it with `fs.watch` | A read per call is a syscall per call for a file that changes once per app launch, and a watcher is a second source of truth that can miss an atomic replace. The two error codes are precisely the two ways the cached numbers can be wrong, and both are reported by the transport for free |
| The forwarded request's timeout is derived from `maxWaitSeconds` plus 30 s | The SDK's 60 s default; `MAX_WAIT_SECONDS` for every call; `resetTimeoutOnProgress` | The default would abort every wait over a minute while the discussion kept running — the worst possible failure, because it looks like an error and costs the user a full round of models. Ten minutes flat would make a dead endpoint hang for ten minutes, and `resetTimeoutOnProgress` makes the ceiling depend on how chatty the group is |
| Only `name` and `arguments` are forwarded; the incoming `_meta` is dropped | Forwarding `params` verbatim | The IDE's `progressToken` means nothing to the endpoint, and the SDK mints this hop's own token when `onprogress` is passed. Forwarding the first hop's token would have the endpoint number its notifications against an id only the IDE's client knows |
| "Is Witena up?" is answered by `readlink(<userData>/SingletonLock)` | Running `pgrep`; asking `open`; not distinguishing the two cases at all | It is used for nothing but choosing between two English sentences, and it is free — WP-0a already established that Electron keeps that `<host>-<pid>` symlink inside `userData` and that it is what makes the single-instance lock per-directory. Every way of failing to read it answers "not running", which falls back to the weaker message, so nothing depends on it |
| `launch()` adds `--env WITENA_USER_DATA=…` when, and only when, the shim was given the override | The plain command in every case | Without it a harness that points the shim at a temporary directory would launch an app writing to the real one and then wait twenty seconds for a file that could never appear. The ordinary launch is still the plain `open -g -j -a <bundle> --args --background` the work package specifies |
| `bundlePathFor` is a suffix match on `<x>.app/Contents/MacOS/<name>`, and `null` is the development branch | Walking up the path looking for any `.app`; reading `Info.plist` | WP-0a measured what `process.execPath` actually is inside the bundle, and WP-9's launcher is what puts it there. A charitable match would let a `node` in some unrelated bundle look launchable, and "there is no bundle" is a *message*, not a failure |
| The shim's closure test also bans `better-sqlite3`, `src/main/` and any package outside the SDK and zod | The electron-only scan its two siblings run | The shim's failure mode is worse: it is bundled with everything inlined and run from a bundle with no `node_modules`, so a stray import is either an unloadable native binary or the whole backend in a file an IDE reads on every project it opens. `import type { HandlerMap }` is the realistic mistake, and it is indistinguishable from a value import to a scan — so the rule is the directory, not the `type` keyword |

### Decisions made in WP-7 (the host and the setting)

| Decision | Alternatives considered | Why this one |
|---|---|---|
| A fresh bearer token on every `start()`, not once per process launch | Generating it when the context is built, or once per launch and reusing it across toggles | PLAN says "random per launch", and for an endpoint switched on once they are the same thing. Per `start()` is the stronger reading and the one a user expects: switching the endpoint off and on again is the gesture that means *stop trusting what was out there*, and a token that survived it would make the switch a smaller thing than it looks |
| `stop()` removes the discovery file **synchronously, before anything is awaited** | Removing it after the socket is closed, in the natural teardown order | `before-quit` in `src/main/index.ts` is a synchronous listener that cannot await, so a quit is only guaranteed to reach the first synchronous statement. The file is the only endpoint state that outlives the process, and a file pointing at a port that is closing is precisely the stale-file case the shim's `parseDiscovery` + `process.kill(pid, 0)` dance exists to survive — not one worth manufacturing |
| `stop()` deletes the file only when its `pid` is this process's | Deleting it unconditionally; deleting it when the pid is not alive | A file naming another pid is a *running* Witena on the same `userData`. The single-instance lock (WP-8) should make that impossible, but a lock is not a proof, and the failure mode of being wrong is breaking a live IDE session in order to tidy up after ourselves. "Not ours" is a cheaper and safer test than "not alive", and it never races a pid that was recycled |
| `writeFileSync(..., { mode })` **and** a `chmodSync` after it | The mode option alone | The option only applies to a file the call *creates*, and every launch after the first writes over a file that is already there. Without the second call the `0600` guarantee would hold exactly once per installation — which is the kind of bug that is invisible until somebody looks at a shared machine |
| The host is **constructed** by `createAppContext` and **started** by `src/main/index.ts` | Starting it inside the context when the setting is on; constructing it in `index.ts` and assigning it | The context is built before anything has read the settings row, and a context that opened a port on construction is one no unit test could build. Construction is free, so `ctx.mcpEndpoint` can be non-null wherever the option is passed, and exactly two places read the setting: the launch and the toggle |
| `ctx.mcpEndpoint` is `McpEndpointHost \| null`, and the option is `{ handlers }` | A boolean option; passing a ready-made host in from `index.ts` | `buildHandlers()` takes no context and the endpoint's tools call handlers, so the map is the one thing the context genuinely cannot derive — and `null` then means something true rather than something missing: the Node host serves MCP over its own routes (PLAN.md, "Online version") and has no discovery file to write. The *setting* is not desktop-only; only the door is |
| A `start()` that fails is logged by `settings.update`, not raised | Rejecting the update; rolling the row back | The row is the user's intent and `host.state` is the truth about this launch, and WP-11's `integrations.status` already reports the two separately. A rejection would leave the row saying "on" while the UI — which reverts a switch on a rejected update — showed "off", which is the one outcome that tells the user nothing useful |
| `start()` and `stop()` are serialised through one promise chain | Guarding with a boolean; trusting the caller not to overlap | The switch, the launch and `before-quit` can all reach the host, and two of those can arrive in the same tick. A boolean guard makes the second caller return before the first has a socket; a chain makes "asked twice" mean "the second answer is about the first one's result", which is the only reading that cannot leave a socket with nothing pointing at it |

### Provenance (WP-13)

| Decision | Alternatives considered | Why this one |
|---|---|---|
| A question the endpoint sends is an **ordinary user message carrying one extra flag part** (`OriginPart`), not a new `SenderType` and not a column | `senderType: 'mcp'`; a `Message.origin` column; a system notice beside the question | Everything downstream of `chat.send` — scheduling, `@` resolution, the round model, the history transform, the renderer's row — already handles a user message, and every one of them would need a new case for a new sender. The flag is invisible to all of them and read by exactly two places: the transcript row model and the chip. PLAN.md chose this shape; WP-13 implemented it |
| The flag is a part, so it needs **no migration**, exactly like `ConclusionPart` | A column plus a migration | `parts` is the open union the database stores as JSON. A row written before S10.4 simply has no flag, which is the correct reading of it: nobody sent that one for the user |
| `client` is **sanitised, never validated**: trimmed, control characters stripped, cut to `MAX_ORIGIN_CLIENT_CHARS`, and an empty result means no flag at all | Rejecting a bad name with `validation`; storing it verbatim and escaping at render time | It is the one string on the backend surface whose text a *remote party* chose — the IDE names itself in `initialize.clientInfo.name` and the shim copies it into `CLIENT_HEADER`. Refusing a whole discussion over the shape of a label would be a tool failure where dropping the label is the honest outcome, and cleaning once at the boundary means the runner, the row model and the chip do not each have to remember to |
| Control characters are **removed, not escaped**, and the rule is `\p{C}` — so bidi overrides and zero-width characters go with them | Stripping only `\x00`–`\x1f`; escaping them for display | The chip is one item on a message header line. A newline, an ANSI escape or a right-to-left override in it is a client trying to look like something it is not, and no client name legitimately contains one. Letters outside ASCII are kept: a client may call itself by a word in its own script, and dropping those would mangle honest names without stopping a dishonest one |
| A caller that sends no `CLIENT_HEADER` is labelled `mcp` rather than left unmarked | Omitting the flag for a direct HTTP caller | The message *did* arrive through the endpoint, and an unmarked row tells the user the opposite — that they typed it themselves. `mcp` says exactly what is known: it came through the endpoint, and the endpoint was not told by whom |
| The history converter ignores the flag, and a test asserts the converted messages are **byte-identical** with and without it | Telling the group which tool is asking | Who *sent* a question is a fact about the transcript, not about the question. A group told that a machine is asking answers the machine: it shortens, it drops the caveats, it writes for a parser. It is `ConclusionPart`'s argument taken one step further |

## What the spike found

> Filled by WP-0a and WP-0b. Until then every number in this feature that came
> from memory rather than measurement is listed in `tasks.md` under "Assumptions".

### WP-0a platform (2026-09-20)

Machine: macOS 27.0 (26A428), Apple Silicon, Electron 44.3.0 / Node 24.20.0.
Two bundles were used. **dist** is `dist/mac-arm64/Witena.app` from
`npm run dist:dir` — Developer ID signed, hardened runtime
(`CodeDirectory … flags=0x10000(runtime)`), not notarized. **installed** is
`/Applications/Witena.app` 0.1.0, which `spctl -a -vvv -t exec` reports as
`accepted, source=Notarized Developer ID` and `xcrun stapler validate` accepts —
so the notarized bundle was measured without downloading anything. Every launch
was given a throwaway `WITENA_USER_DATA` under the scratchpad, and every process
started here was quit again.

**1. Run-as-node from the shipped bundle — confirmed.**

```
printf 'one\ntwo\nthree\n' (one line per second, through a pipe) |
  ELECTRON_RUN_AS_NODE=1 <bundle>/Contents/MacOS/Witena echo.cjs
```

Both bundles run the script. `process.versions.node` is `24.20.0`,
`process.versions.electron` is `44.3.0`, `process.execPath` is the bundle's own
`Contents/MacOS/Witena`. stdin and stdout are **unbuffered when piped**: with the
writer sending one line per second, each echoed line came back 1–3 ms after it
was written, not in one burst at exit. The hardened runtime does not block it —
the notarized, stapled bundle behaves exactly like the locally signed one.

*No Dock icon.* While a run-as-node process was alive,
`lsappinfo list | grep -c 'bundleID="com.witena.app"'` stayed at 1 (the user's
own running app) and `lsappinfo info -only pid,name <pid>` returned nothing: the
process never registers with LaunchServices, so it has no Dock tile and no menu
bar. Startup cost of the wrapper is small — `/usr/bin/time -p` on a one-line
script gives 0.07–0.08 s real from either bundle, against 0.06 s for `node`
itself.

*Fuses.* There is no fuse configuration anywhere: no `@electron/fuses` in
`package.json`, no `flipFuses` call in `scripts/`, and `electron-builder.yml` has
no `afterPack` / `afterSign` hook that could flip one. `RunAsNode` is therefore
at Electron's default, which the runs above prove is *enabled*. **It must stay
that way** — `bin/witena-mcp` (WP-9) has no other way to execute the shim.

**2. Hidden launch — confirmed, with two findings.**

```
open -g -j -a dist/mac-arm64/Witena.app \
  --env WP0A_LOG=<log> --env WITENA_USER_DATA=<temp> --args --background
```

`--background` **is** in `process.argv` of a packaged build, and nothing else is:
`argv === ['<bundle>/Contents/MacOS/Witena', '--background']`, so the packaged
argv has no extra entries to skip (`app.isPackaged` was `true`). Read from a
temporary `appendFileSync` in `src/main/index.ts`, reverted afterwards.

*Focus is kept.* The frontmost application (`lsappinfo front`) was the same
before and after each launch. The window the app still creates — `--background`
is not implemented until WP-8 — did not come forward.

Cold start, three runs, from the `open` call to the line logged immediately after
`createWindow()` (the whole of `whenReady`: database opened, handlers registered,
window created, which is where WP-7's host would already be listening):

| Run | process start | electron `ready` | window created |
|---|---|---|---|
| 1 (first launch of a freshly built bundle) | +2649 ms | +2710 ms | **+2853 ms** |
| 2 | +506 ms | +566 ms | **+709 ms** |
| 3 | +502 ms | +550 ms | **+692 ms** |

Almost all of it is `open` plus process start; from `ready` to a usable app is
~145 ms. **WP-5's 20 s launch timeout is comfortably right** — a factor of seven
over the worst number here. The first run is the only cold one; a bundle macOS
has already validated starts in ~0.7 s.

*Finding for WP-5:* `open -a <bundle>` on a bundle that is **already running**
does not start a second instance and prints *"Application … was already running
and so the additional environment variables could not be set."* For the shim this
is the desired behaviour (an app that is up already has a discovery file), but it
means `open` can never be used to *re-configure* a running Witena, and any test
that needs two instances of the same bundle must pass `-n`.

*Finding for WP-9 and for anyone measuring:* a launch of a **second Developer ID
signed copy** of the app with a *fresh* `WITENA_USER_DATA` raises a macOS
SecurityAgent (Keychain) prompt from `safeStorage`, and `whenReady` blocks on it
until it is answered — no database, no window, no endpoint. It does not affect a
user's normal launch (same bundle, existing key file), but it is why the numbers
above were taken with `createSafeStorageStore()` temporarily stubbed out. The
step it skips is a Keychain read of a few milliseconds.

**3. `userData` and the single-instance lock — confirmed.**

`app.getPath('userData')` read before any override, in the packaged build, is
`/Users/<user>/Library/Application Support/Witena`. **`<APP_DIR>` is `Witena`**
(`app.setName(APP_NAME)` runs before it), which is what `userDataDirFor` in
`src/shared/mcp-discovery.ts` must produce for the no-override case. Corroborated
independently by the running app's helper processes, whose command line carries
`--user-data-dir=/Users/<user>/Library/Application Support/Witena`.

`requestSingleInstanceLock()` called immediately after
`app.setPath('userData', …)` **is keyed by `userData`**:

| Instance | `WITENA_USER_DATA` | `requestSingleInstanceLock()` |
|---|---|---|
| A | `…/udA` | `true` |
| B, launched while A runs | `…/udB` | `true` |
| A2, launched while A runs | `…/udA` | `false` |

A and B ran side by side, each with its own window. The mechanism is visible in
the directory: Chromium writes `SingletonLock -> <host>-<pid>` (plus
`SingletonCookie`, `SingletonSocket`) **inside** `userData`, so parallel
Playwright launches with different temp directories cannot evict each other.
Note for WP-8: the instance that loses the lock never reaches `ready` at all — it
sat parked until it was killed — so `app.quit()` on `false` is what ends it
cleanly, and nothing may be assumed to run afterwards.

### WP-0b clients (2026-09-20)

Measured on macOS (Darwin 27.0.0, arm64) against a throwaway stdio MCP server
(`sleep { seconds, quiet? }` emitting a progress notification every 5 s, plus one
resource `witena-spike://note/1` and one prompt `consult`) built on
`@modelcontextprotocol/sdk` 1.30.0 and run by Node v22.22.0. The server logged
every JSON-RPC method it received, which is where the "what the client asks for"
claims below come from. Everything added was removed again: `claude mcp list`
ends at "No MCP servers configured" and `codex mcp list` is back to its original
four servers.

**Where the two CLIs are.** Neither is on the `PATH` of a plain non-login shell,
and neither is on the login shell's `PATH` either (`zsh -lic 'command -v claude;
command -v codex'` printed nothing for either). They were found on disk:

| CLI | Path | Version |
|---|---|---|
| Claude Code | `~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude` | `2.1.275 (Claude Code)` |
| Codex | `/Applications/ChatGPT.app/Contents/Resources/codex` | `codex-cli 0.155.0-alpha.9` |

*What WP-11 must do:* resolving by `PATH` alone is not enough, and neither is a
`~/.claude/local/` or `~/.npm-global/bin` guess — neither directory exists here.
Probe in order: `PATH`, then the two paths above (globbing the Claude Code version
directory and taking the highest), then report `installed: false`. Claude Code's
binary is a multi-call executable, so "the file exists" is not proof — confirm
with `<path> --version`.

**Item 1 — `mcp add` / `list` / `get` / `remove`.** *Confirmed* for both.

Claude Code, user scope:

```
claude mcp add witena-spike --scope user -e SPIKE_ENV=hello \
  -- /path/to/node /path/to/server.cjs --flag1 spikearg
→ Added stdio MCP server witena-spike with command: … to user config
  File modified: /Users/<me>/.claude.json
```

It writes the top-level `mcpServers` object of `~/.claude.json` (verified by
reading the file back: `{ "type": "stdio", "command", "args", "env" }`). The `--`
separator is required before a command that takes flags of its own; `-e KEY=value`
is repeatable; `-t/--transport` defaults to `stdio`. `claude mcp get witena-spike`
prints scope, a live `Status: ✔ Connected`, command, args and env, and ends with
the removal command. `claude mcp list` health-checks every server and prints one
`… - ✔ Connected` line each. `claude mcp remove witena-spike -s user` removes it.
All four subcommands work **while the CLI is not logged in** — installing does not
need an authenticated session.

Codex has no scope flag; `codex mcp add` is always global:

```
codex mcp add witena-spike --env SPIKE_ENV=hello \
  -- /path/to/node /path/to/server.cjs --flag1 spikearg
→ Added global MCP server 'witena-spike'.
```

It writes `~/.codex/config.toml` as `[mcp_servers.witena-spike]` with `command`
and `args`, plus a nested `[mcp_servers.witena-spike.env]` table.
`codex mcp get witena-spike --json` is the form for WP-11 to parse — it returns
`{ name, enabled, transport: { type, command, args, env, cwd }, startup_timeout_sec,
tool_timeout_sec }` — because the human-readable `codex mcp get` and `codex mcp
list` **mask every env value as `*****`** while `--json` does not.
`codex mcp list --json` returns that shape as an array. `codex mcp remove
witena-spike` removes it. Two cautions for WP-11: adding or removing rewrites the
whole `config.toml` and normalises unrelated entries (here another server's
`startup_timeout_sec = 120` became `120.0` and its `args = []` line was dropped);
and `codex mcp list` also reports servers injected by Codex plugins that are not
in `config.toml` at all, so "is Witena connected" must be decided by name.

**Item 2 — startup and tool-call timeouts.**

*Claude Code startup: measured, 30 000 ms.* Re-adding the server with
`-e SPIKE_STARTUP_DELAY_MS=<n>` and running `claude mcp list`:

| delay | result |
|---|---|
| 0 ms | `✔ Connected` (1 s) |
| 25 000 ms | `✔ Connected` (26 s) |
| 35 000 ms | `✘ Failed to connect — MCP server "witena-spike" connection timed out after 30000ms` |
| 35 000 ms with `MCP_TIMEOUT=45000` | `✔ Connected` (36 s) |

The shipped code agrees: `MCP_TIMEOUT` when set and positive, else `30000` (plus a
separate `MCP_CONNECT_TIMEOUT_MS ?? 5000` for remote transports). The shim
therefore has a 30 s budget to answer `initialize`, which is ample for serving
`tools/list` out of `src/shared/mcp-tools.ts` without launching the app.

*Claude Code tool-call: could not be run here* — this machine's `claude` CLI is
not logged in (`claude -p …` returns `Not logged in · Please run /login` in ~2 s,
before any model call), so no tool could be invoked through it. What the shipped
binary says about the two knobs, quoted from its own strings:

- Hard per-call limit: per-server `timeout` (milliseconds) in the MCP server
  entry, else `MCP_TOOL_TIMEOUT`, else a built-in `1e8` ms (~27.8 h), clamped to
  `[1000, 2147483647]`. Its description is explicit — *"Hard wall-clock limit per
  call; progress notifications do not extend it. Values below 1000ms are
  ignored."* Error text: `MCP server "<s>" tool "<t>" timed out after <n>s`.
- Idle watchdog: `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (ms, `0` disables), default
  `1 800 000` ms (30 min) for stdio and `300 000` ms for remote, polled every 30 s
  and capped by the hard limit. This one **is** reset by progress: `MCP server
  "<s>" tool "<t>" sent no response or progress for <n>s; aborting.`

So a default stdio install of Claude Code imposes no practical per-call ceiling,
and a 50 s return sits far inside both limits. WP-15 must still exercise the
tool-call path on a logged-in machine before leaning on these numbers.

*Codex tool-call: measured, and the ~60 s assumption is **refuted**.* Runs used
`codex exec --sandbox read-only --skip-git-repo-check` with every other MCP server
disabled for the invocation (`-c mcp_servers.node_repl.enabled=false`,
`-c 'mcp_servers.cua_repl={command="/usr/bin/true",enabled=false}'`, verified by
`codex mcp list --json` showing only `witena-spike` enabled), one run per
duration, prompt `call the sleep tool with seconds=N and report what it returned`:

| `seconds` | progress sent | result | wall |
|---|---|---|---|
| 40 | yes (8 notifications) | returned `WITENA_SPIKE_SLEPT_40_SECONDS` | 57 s |
| 70 | yes (14) | returned `WITENA_SPIKE_SLEPT_70_SECONDS` | 84 s |
| 130 | yes (26) | returned `WITENA_SPIKE_SLEPT_130_SECONDS` | 146 s |
| 130 | **no** (`quiet=true`) | returned `WITENA_SPIKE_SLEPT_QUIET_130_SECONDS` | 145 s |

The silent 130 s call is the decisive one: Codex's tolerance is not progress
keeping the call alive, it is that **there is no default tool-call timeout**.
`tool_timeout_sec` is `null` on a freshly added server and the binary contains no
"tool call timed out" message at all. A user — or a plugin, as the bundled
`codex_app` server does with `tool_timeout_sec = 3600.0` — can set
`tool_timeout_sec` per server in `config.toml`; nothing sets one by default. Codex
does ask for progress (every call arrived with `progressToken: 1`), but nothing
observed depends on it.

*Codex startup: measured, and it does not block.* With
`-c 'mcp_servers.witena-spike.env.SPIKE_STARTUP_DELAY_MS="20000"'` the turn ran to
completion in 11 s and the model answered *"No sleep tool is available in this
session"*; at `120000` the same, in 5 s and 13 s. The server process was spawned
in every case but had not yet connected. So Codex starts MCP servers without
holding up the turn, and a server that misses the window is **silently absent** —
no error to the user, no retry, just a session without Witena tools. The budget is
under 20 s (PLAN's `~10 s` is a safe reading), and it is raised per server with
`startup_timeout_sec`; the CLI's own failure text is *"MCP client for `<name>`
timed out after <P> seconds. Add or adjust `startup_timeout_sec` in your
config.toml"*.

*This is the strongest argument for the shim design PLAN already chose* and it
should not be weakened: the shim must answer `initialize` and `tools/list` from
`src/shared/mcp-tools.ts` in well under 10 s and must never launch the app on that
path, because under Codex the penalty for being slow is not a visible error — it
is the tools quietly not existing.

**Decision: keep `DEFAULT_WAIT_SECONDS = 50`.** Nothing measured forces a change,
and nothing measured justifies raising it. Claude Code's hard limit is effectively
unbounded by default but is *not* extended by progress and can be lowered to as
little as 1 s by a user's per-server `timeout` or `MCP_TOOL_TIMEOUT`; Codex has no
default limit, but any `tool_timeout_sec` a user or plugin sets is a hard ceiling.
50 s sits under any floor either client is realistically configured with, keeps
the chunking contract (`status: "running"` → `wait_for_discussion`) exercised on
every real discussion instead of only on long ones, and still leaves
`maxWaitSeconds` up to 600 for a caller that knows its own configuration.
`MIN_WAIT_SECONDS = 5` and `MAX_WAIT_SECONDS = 600` are unaffected.

**Item 3 — resources and prompts.** *Codex: resources yes, prompts no.* Asked to
`read the MCP resource witena-spike://note/1`, Codex called its own built-in
`list_mcp_resources` tool and then `witena-spike/read_mcp_resource`, and reported
`WITENA_SPIKE_RESOURCE_BODY_42` correctly. The server log shows `resources/list`
and `resources/read` arriving ~4 s into the turn — lazily, once the model asked.
It never sent `prompts/list`, in that run or any other, and the binary carries
handlers for `list_mcp_resources`, `read_mcp_resource` and
`list_mcp_resource_templates` but none for prompts. So Codex exposes resources
**as tools to the model**, not as an `@`-mention affordance, and does not expose
prompts at all.

*Claude Code: both are discovered; the UX could not be exercised.* On every
session start the server received `initialize`, `notifications/initialized`,
`tools/list`, `prompts/list` and `resources/list` — so Claude Code asks for both
capabilities up front (its `claude mcp list` health check asks only for
`tools/list`). Whether they then surface as `@witena:…` and
`/mcp__witena__consult` could not be checked, because the CLI is not logged in.

*What S10.6 / WP-15 should take from this:* the resource is worth shipping — both
clients fetch it, by different routes — so `witena://chat/<id>` must read well
both as an `@`-mention body and as a tool result. The `consult` prompt is
Claude-Code-only: build it, but let nothing depend on it.

**Item 4 — the Claude Code subagent file: *could not be run here*.**
`~/.claude/agents/witena-spike.md` was written with
`tools: mcp__witena-spike__sleep`, and the CLI started with it in place and raised
no parse warning — but the same "Not logged in" wall stops the real test. Whether
`@witena-spike` resolves, and whether a subagent restricted to `mcp__<server>__*`
can reach those tools, is still unverified. The file and the `~/.claude/agents/`
directory (which did not exist before) were deleted. **WP-14/WP-15 must verify
this on a logged-in machine before the generated `~/.claude/agents/witena-<slug>.md`
per committee is built on it** — it is the one S10.5 assumption this spike could
not retire. Note for that work: `claude agents` manages *background sessions*, not
subagent definitions, so no CLI lists or validates these files; the check has to
be an actual `@`-mention inside a session.

**Cleanup, proved.** `diff` of `~/.claude.json` against the snapshot taken before
the spike: identical (`claude mcp remove` left an empty `"mcpServers": {}` behind,
which was removed). `~/.codex/config.toml` no longer contains `witena-spike`; it
differs from its snapshot only by Codex's own reordering and float-normalisation
of the pre-existing `node_repl` entry described above, and was deliberately not
restored byte-for-byte because the Codex app was running and owns that file.

## Open questions

- The real names of Phase 9's handlers and types (WP-14 reads them, never guesses).
- ~~Whether Codex surfaces MCP resources or prompts at all (WP-0b); S10.6 drops
  whatever no client shows.~~ Answered by WP-0b: Codex reads resources (through
  its own `list_mcp_resources` / `read_mcp_resource` tools) and ignores prompts
  entirely. S10.6 keeps the resource and ships the `consult` prompt as a
  Claude-Code-only extra.
- Whether a user-level Claude Code subagent restricted to `mcp__witena__*` can be
  `@`-mentioned and reach those tools (WP-0b could not test it — the CLI on the
  spike machine was not logged in). S10.5's per-committee agent file depends on
  it; WP-14/WP-15 must check it on a logged-in machine first.
