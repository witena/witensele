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
