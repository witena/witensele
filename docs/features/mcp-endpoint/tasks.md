# mcp-endpoint — Work packages

STEPS.md Phase 10 cut into packages that one subagent can finish and prove on its
own. A package is the unit of delegation, of review and of merge.

## How to run a package

1. **Branch.** `feat/mcp-endpoint` is the integration branch. A package works in
   its own worktree on `feat/mcp-endpoint-wp<N>` cut from the integration branch
   *after* every package it depends on has been merged into it.
2. **Read first**, in this order: `CLAUDE.md`; PLAN.md "Witena as an MCP server";
   `context.md` here; "Frozen contracts" below; the package's own section; the
   files it names under *Read*.
3. **Stay inside the package.** *Touches* is the complete list of existing files
   a package may edit; new files go where *Delivers* says. Anything else that
   seems necessary is a finding to report, not a change to make.
4. **The contracts are frozen.** A package that needs a contract changed stops
   and reports; it does not edit "Frozen contracts" and carry on, because another
   package is being written against the same text at the same time.
5. **Gate.** Every package ends with `npm run typecheck` and `npm test` green,
   plus its own *Verify* commands. Paste the tail of each command's output in the
   report. A package with e2e runs only the spec files it names — other agents
   share this machine.
6. **Docs.** Each package updates the four documents of every feature listed
   under *Docs*, in the same commit as the code (CLAUDE.md rule 2), and ticks its
   box in STEPS.md. English only (rule 1).
7. **Report** back: what was built, the verification output, every deviation from
   this file, and anything learned that a later package needs.

Nothing here is measured yet. Until WP-0a / WP-0b land, these are **assumptions**:
Codex's ~10 s startup and ~60 s tool timeout; `ELECTRON_RUN_AS_NODE` working in
the notarized bundle; `open -g -j` launching hidden; the single-instance lock
being keyed by `userData`; Claude Code `@`-mentioning a user-level subagent whose
only tools are `mcp__witena__*`. A package that finds one false stops and reports.

## Dependency graph

```
WP-0a platform spike ─┐ (findings feed WP-5, WP-8, WP-9; none blocks coding)
WP-0b client spike ───┘ (findings feed WP-11, WP-14, WP-15)

WP-1 contracts
 ├─ WP-2 watcher ── WP-3 tools ──┐
 ├─ WP-4 http endpoint ──────────┼─ WP-6 contract test (S10.1 done)
 │                               │
 ├─ WP-5 shim (needs WP-4) ──────┤
 │                               ├─ WP-7 host ── WP-10 e2e ── WP-9 packaging (S10.2, S10.3 done)
 └─ WP-8 lock / background / deep link (needs only WP-1)
WP-11 integrations backend (WP-7, WP-0b) ── WP-12 settings UI
WP-13 OriginPart (WP-3, WP-5)                                   (S10.4 done)
WP-14 committees (WP-3, WP-12, Phase 9 S9.1 merged)             (S10.5)
WP-15 resources + prompt (WP-6, WP-5, WP-0b)                    (S10.6)
WP-16 README + backlog (everything)                             (S10.7)
```

Safe to run in parallel: {WP-0a, WP-0b, WP-1}; then {WP-2, WP-4, WP-8}; then
{WP-3, WP-5}; then {WP-6, WP-7}; then {WP-9 after WP-10, WP-11, WP-13}. Packages in
one set touch disjoint existing files — that is what *Touches* is for. The shared
hot files are `src/shared/types.ts`, `src/shared/backend.ts`, the two locale files
and `src/main/index.ts`; no two packages of one set edit the same one.

| STEPS step | Packages |
|---|---|
| S10.0 | WP-0a, WP-0b |
| S10.1 | WP-1, WP-2, WP-3, WP-4, WP-6 |
| S10.2 | WP-5 |
| S10.3 | WP-7, WP-8, WP-9, WP-10 |
| S10.4 | WP-11, WP-12, WP-13 |
| S10.5 | WP-14 |
| S10.6 | WP-15 |
| S10.7 | WP-16 |

## Frozen contracts

Written by WP-1 exactly as below; every other package codes against them.

```ts
// src/shared/mcp-tools.ts — imports zod and nothing else of ours
export const MCP_SERVER_NAME = 'witena'
export const MCP_PATH = '/mcp'
/** Lower-case; the shim sets it from `initialize.clientInfo.name`. */
export const CLIENT_HEADER = 'x-witena-client'

export const MCP_TOOL_NAMES = [
  'list_chats', 'list_agents', 'start_discussion',
  'wait_for_discussion', 'get_discussion', 'stop_discussion'
  // WP-14 inserted 'list_committees' after 'list_agents'.
] as const
export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

export const MIN_WAIT_SECONDS = 5
export const MAX_WAIT_SECONDS = 600
export const DEFAULT_WAIT_SECONDS = 50
/** question + context, in characters. */
export const MAX_DISCUSSION_INPUT_CHARS = 200_000
/** One `positions` entry is cut to this and flagged `truncated`. */
export const MAX_POSITION_CHARS = 4_000

export type DiscussionStatus =
  | 'running' | 'concluded' | 'ended' | 'stopped' | 'error' | 'needs-attention'

export interface DiscussionResult {
  status: DiscussionStatus
  chatId: string
  /** `witena://chat/<id>` */
  url: string
  /** Highest round reached by the run this result describes; 0 before round 1. */
  round: number
  conclusion?: { messageId: string; agentName: string; markdown: string }
  /** Present when `status` is `ended`: the last say of each participant. */
  positions?: { agentName: string; markdown: string; truncated: boolean }[]
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  /** Present when `status` is `error`. English, for the calling model. */
  error?: string
  /** One English sentence telling the calling model what to do next. */
  hint: string
}

/** zod input schema per tool; `z.infer` gives the argument type. */
export const MCP_TOOL_INPUTS: { [N in McpToolName]: z.ZodObject<z.ZodRawShape> }
export interface McpToolDefinition {
  name: McpToolName
  title: string
  description: string
  inputSchema: Record<string, unknown> // z.toJSONSchema(MCP_TOOL_INPUTS[name])
}
export const MCP_TOOLS: readonly McpToolDefinition[]

export function chatUrl(chatId: string): string
/** `null` for anything that is not exactly `witena://chat/<uuid>`. */
export function parseChatUrl(url: string): string | null
```

Tool inputs (the zod shapes): `list_chats { query?: string }` ·
`list_agents {}` ·
`start_discussion { question: string; context?: string; chatId?: string;
agents?: string[]; title?: string; workdir?: string; rounds?: int 1..10;
maxWaitSeconds?: int 5..600 }` with the refinement *exactly one of `chatId` or a
non-empty `agents`*, and `title` / `workdir` only without `chatId` ·
`list_committees {}` (WP-14) ·
`wait_for_discussion { chatId; maxWaitSeconds? }` ·
`get_discussion { chatId; detail: 'conclusion' | 'transcript'; afterMessageId? }` ·
`stop_discussion { chatId }`. **`committee` was added by WP-14**, which is the
one sanctioned change to this section: `start_discussion` gained
`committee?: string`, and its first refinement became *exactly one of `chatId`
or a new group — `committee`, a non-empty `agents`, or both*. `title` /
`workdir` are unchanged, and `committee` is only legal without `chatId`.
WP-14 also added `committee?` to the `consult` prompt (WP-15 left it out on
purpose). No other contract above was touched.

```ts
// src/shared/mcp-discovery.ts — pure; no node: imports
export const DISCOVERY_FILE = 'mcp-endpoint.json'
export const DISCOVERY_VERSION = 1
export interface McpDiscovery {
  version: 1; port: number; token: string; pid: number; startedAt: number
}
export function parseDiscovery(text: string): McpDiscovery | null
/** `env.WITENA_USER_DATA`, else `<home>/Library/Application Support/<APP_DIR>`. */
export function userDataDirFor(env: Record<string, string | undefined>, home: string): string
```

```ts
// src/main/mcp-endpoint/tools.ts
export interface ToolCallContext {
  ctx: AppContext
  handlers: HandlerMap
  /** From CLIENT_HEADER; undefined for a direct HTTP client. */
  client?: string
  /** Aborted when the MCP request is cancelled or the socket closes. */
  signal: AbortSignal
  progress?: (update: { message: string; round?: number }) => void
}
export type ToolOutcome =
  | { ok: true; structured: unknown; text: string }
  | { ok: false; code: BackendErrorCode | 'busy'; message: string }
export type ToolRegistry = {
  [N in McpToolName]: (args: unknown, call: ToolCallContext) => Promise<ToolOutcome>
}
export function createTools(): ToolRegistry

// src/main/mcp-endpoint/discussion.ts
export interface WatchOptions {
  chatId: string
  /** Only messages with `seq` greater than this belong to the discussion. */
  afterSeq: number
  deadlineMs: number
  signal: AbortSignal
  progress?: ToolCallContext['progress']
}
/** Subscribes synchronously, so call it BEFORE `chat.send`; settle with `result`. */
export function watchDiscussion(ctx: AppContext, handlers: HandlerMap, o: WatchOptions):
  { result: Promise<DiscussionResult>; cancel(): void }
/** No waiting: what the transcript says right now. */
export function readDiscussion(ctx: AppContext, handlers: HandlerMap,
  o: { chatId: string; afterSeq: number }): Promise<DiscussionResult>

// src/main/mcp-endpoint/server.ts
export interface McpEndpointOptions {
  ctx: AppContext; handlers: HandlerMap; token: string
  /** Defaults to `createTools()`; WP-4's tests pass a stub. */
  tools?: ToolRegistry
}
export interface McpEndpoint {
  /** Answers every request on MCP_PATH; anything else is the caller's. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  close(): Promise<void>
}
export function createMcpEndpoint(o: McpEndpointOptions): McpEndpoint

// src/main/mcp-endpoint/host.ts — node:http + node:fs, no electron
export interface McpEndpointHost {
  readonly state: { listening: false } | { listening: true; port: number }
  /** Idempotent. Listens on 127.0.0.1:0, then writes the discovery file 0600. */
  start(): Promise<void>
  /** Idempotent. Removes the discovery file, closes sockets. */
  stop(): Promise<void>
}
export function createMcpEndpointHost(o: {
  ctx: AppContext; handlers: HandlerMap; userDataDir: string
  randomToken?: () => string; pid?: number
}): McpEndpointHost
```

```ts
// additions to src/shared/types.ts, each made by the package named
export interface McpEndpointSettings { enabled: boolean }          // WP-7
//   AppSettings.mcpEndpoint (default { enabled: false }); AppSettingsPatch.mcpEndpoint?: Partial<…>
export interface OriginPart { type: 'origin'; client: string }     // WP-13
//   added to MessagePart; ChatSendInput.origin?: { client: string }
export type IdeClientId = 'claude-code' | 'codex'                  // WP-11
export interface IdeClientStatus {
  id: IdeClientId; installed: boolean; connected: boolean
  /** The command the IDE has registered, when connected. */
  command?: string
  /** Connected, but `command` is not this installation's launcher. */
  stale: boolean
}
export interface IntegrationStatus {
  endpoint: { enabled: boolean; listening: boolean; port?: number }
  /** Absolute path of `bin/witena-mcp`; null in a build that ships none. */
  launcherPath: string | null
  clients: IdeClientStatus[]
}

// additions to src/shared/events.ts
export interface UiOpenChatEvent { type: 'ui.open-chat'; chatId: string } // WP-8

// additions to src/shared/backend.ts (and BACKEND_METHODS)               // WP-11
'integrations.status': () => Promise<IntegrationStatus>
'integrations.connect': (input: { client: IdeClientId }) => Promise<IntegrationStatus>
'integrations.disconnect': (input: { client: IdeClientId }) => Promise<IntegrationStatus>
```

Status mapping, used by WP-2 and asserted by WP-6: `run.finished` `completed` with
a `ConclusionPart` message after `afterSeq` → `concluded`; `completed` without
one, or `max-rounds` → `ended` with `positions`; `stopped` → `stopped`; `error` →
`error`; a `permission.requested` for the chat while waiting → `needs-attention`
(the run keeps going); the deadline → `running`.

---

## WP-0a Platform spike

**STEPS** S10.0 bullets 1–3 · **Depends on** nothing · **Touches**
`docs/features/mcp-endpoint/context.md`, STEPS.md · **Delivers** throwaway scripts
under the scratchpad, never under `src/`.

Do, on this Mac, and record command + observed result for each:
1. `npm run dist:dir`, then
   `ELECTRON_RUN_AS_NODE=1 dist/mac-arm64/Witena.app/Contents/MacOS/Witena <script.cjs>`
   where the script echoes stdin lines to stdout: works? Dock icon? stdout
   unbuffered when piped? Repeat against the notarized v0.1.0 app if it is
   installed in `/Applications` (report "not installed" otherwise — do not
   download it). Confirm `electron-builder.yml` and the build scripts configure no
   Electron fuses.
2. `open -g -j -a dist/mac-arm64/Witena.app --args --background`: is focus kept,
   is `--background` in `process.argv` (read it from the app's stdout log or a
   temporary `console.log`, reverted afterwards), cold-start time from `open` to
   the window-less process being up (three runs).
3. What `app.getPath('userData')` is in a packaged build (the `<APP_DIR>` of
   `userDataDirFor`), and whether `requestSingleInstanceLock()` called after
   `app.setPath('userData', …)` lets two instances with different
   `WITENA_USER_DATA` coexist — a 20-line throwaway Electron main is enough.

**Verify** `context.md` "What the spike found" has one dated entry per item with
the command and the result; `git status` shows no change under `src/`.
**Done when** each item says *confirmed*, *refuted* (with what PLAN must change)
or *could not be run here* (with why).

## WP-0b Client spike

**STEPS** S10.0 bullet 4 · **Depends on** nothing · **Touches** `context.md`,
STEPS.md.

Write a ~30-line stdio MCP server in the scratchpad (SDK already installed) with
`sleep { seconds }`, which emits a progress notification every 5 s, plus one
resource and one prompt. For **each of `claude` and `codex` that is on this
machine** (report "not installed" otherwise, never guess):
1. The exact `mcp add` invocation for a user-scoped stdio server with args and
   env, where it writes, how `mcp list` / `mcp get` report it, how to remove it.
   Remove everything you add.
2. Startup timeout and tool-call timeout: defaults, how to configure, and whether
   progress notifications extend the tool timeout (run `sleep` at 40, 70, 130 s in
   non-interactive mode: `claude -p`, `codex exec`).
3. Whether resources (`@server:uri`) and prompts (`/mcp__server__name`) surface.
4. Claude Code only: a `~/.claude/agents/witena-spike.md` whose `tools:` is only
   the spike server's tool — can it be invoked by name and does it reach the tool?
   Delete the file afterwards.

**Verify** as WP-0a, plus `claude mcp list` / `codex mcp list` show no spike
entry. **Done when** `context.md` states the default `maxWaitSeconds` to keep (or
the number to change `DEFAULT_WAIT_SECONDS` to) and the exact CLI forms WP-11 uses.

## WP-1 Contracts

**STEPS** S10.1 bullet 1, S10.2 bullet 2 (the shared half) · **Depends on**
nothing · **Delivers** `src/shared/mcp-tools.ts`, `src/shared/mcp-discovery.ts`,
and a `.test.ts` beside each · **Touches** nothing existing except the feature
docs, `docs/README.md` (the index row) and `CLAUDE.md`'s `shared/` line.

Build exactly "Frozen contracts". Tool descriptions are prompts for a coding
agent: `start_discussion` says to pass the relevant code or diff as `context`,
that the group is read-only and *the caller applies the conclusion*, and that
`status: "running"` means call `wait_for_discussion` with the same `chatId`.

**Tests** every `MCP_TOOLS[i].inputSchema` is a JSON Schema object with
`type: 'object'`; names equal `MCP_TOOL_NAMES`; the `start_discussion` refinement
(both / neither of `chatId` and `agents`, `title` with `chatId`); wait bounds;
`chatUrl` ∘ `parseChatUrl` round-trips and rejects other schemes, paths and
non-uuids; `parseDiscovery` rejects wrong version, missing fields, non-JSON;
`userDataDirFor` with and without the env override. The file imports nothing from
`src/main` or `node:` (assert by reading its source).
**Verify** `npx vitest run src/shared/mcp-tools.test.ts src/shared/mcp-discovery.test.ts`
· gate. **Docs** `mcp-endpoint` (implement.md "Key types"; the other three get
their first real content or "not built yet").

## WP-2 Discussion watcher

**STEPS** S10.1 bullet 2 · **Depends on** WP-1 · **Delivers**
`src/main/mcp-endpoint/discussion.ts` + test · **Touches** feature docs only ·
**Read** `src/main/orchestration/chat-runner.ts` (closing turn, `markConclusion`,
when `run.finished` is emitted relative to the last `message.updated`),
`src/shared/events.ts`, `src/server/http.test.ts` (the mock-model injection).

`watchDiscussion` subscribes to `ctx.events` synchronously and settles once, on
the first of: `run.finished` for the chat, `permission.requested` for the chat,
the deadline, `signal` abort (→ `running`, and unsubscribe; aborting the *wait*
never stops the *run*). `round` tracks `run.round`. `progress` is called on
`run.round` ("Round 2 — Ada, Lin") and on each agent `message.updated` with a
final status ("Ada has spoken"); names come through `agents.list`. The result is
built by `readDiscussion`, which reads through `handlers['messages.list']` and
`handlers['messages.usageSummary']` — not repositories. `positions`: for each
non-executor member, the last `done` agent message with `seq > afterSeq`, text
parts joined, cut at `MAX_POSITION_CHARS`. Every subscription is released on
every path — assert it.

**Tests** (real `createAppContext` on `:memory:` with a mock model, as
`http.test.ts`): concluded (all `[AGREED]`) → conclusion text and agent name;
`max-rounds` → `ended` + one position per member, truncation flagged; deadline →
`running` then a second `watchDiscussion` on the same chat → final result;
`chat.stop` → `stopped`; a model that throws → `error`; an emitted
`permission.requested` → `needs-attention`; abort → `running`; listener count on
the bus back to its starting value after each.
**Verify** `npx vitest run src/main/mcp-endpoint/discussion.test.ts` · gate.
**Docs** `mcp-endpoint`; `orchestration/implement.md` gains one line **only if**
the watcher relies on an ordering between `message.updated` and `run.finished` —
then also a test in this package that pins it.

## WP-3 Tools

**STEPS** S10.1 bullet 3 · **Depends on** WP-2 · **Delivers**
`src/main/mcp-endpoint/tools.ts`, `transcript.ts` (markdown rendering for
`get_discussion`) + tests · **Touches** feature docs only · **Read**
`src/main/handlers/chats.ts`, `src/main/errors.ts`, `app-context.ts` (`runners`).

`createTools()` per the contract. Every tool parses `args` with
`MCP_TOOL_INPUTS[name]` first (failure → `{ ok: false, code: 'validation' }` with
zod's message) and calls **handlers only**. `start_discussion`: resolve each
`agents` entry by id, else case-insensitive exact name; unknown or ambiguous →
validation listing the candidates; an `executor` → validation saying the caller is
the executor. New chat: `chats.create` with `memberAgentIds`, `title` (default:
first line of `question`, 60 chars), `workdir` (absolute and existing, else
validation). Existing chat: `busy` when its runner `isRunning`. `afterSeq` = the
highest `seq` before sending. Message text = `question`, then a blank line and
`context` when given; over `MAX_DISCUSSION_INPUT_CHARS` → validation naming the
cap. Order: `watchDiscussion` → `chat.send` (`rounds` passed through) → await. If
`chat.send` throws, `cancel()` the watcher. `wait_for_discussion`: not running →
`readDiscussion` with `afterSeq` = the `seq` of the chat's last **user** message
minus one. `get_discussion` `transcript`: markdown, `**Name** (round n)` headers,
conclusion marked, tool calls summarised to one line, reasoning omitted.
`BackendFailure` → `{ ok: false, code }`; anything else → `internal` with the
message and no stack. `text` is a readable rendering of `structured`, ending with
`hint`.

**Tests** each tool's happy path; name resolution (id, name, case, ambiguous,
unknown); executor refused; `busy`; both caps; `workdir` relative / missing;
`chat.send` failure cancels the watcher; `wait_for_discussion` on an idle chat
with and without a conclusion; transcript rendering snapshot; a `BackendFailure`
`not_found` surfaces as `not_found`.
**Verify** `npx vitest run src/main/mcp-endpoint/` · gate. **Docs** `mcp-endpoint`.

## WP-4 HTTP endpoint

**STEPS** S10.1 bullets 4–5 · **Depends on** WP-1 (parallel with WP-2/3: it takes
`tools` by injection) · **Delivers** `src/main/mcp-endpoint/server.ts`,
`guards.ts` + tests, and the no-electron closure test for
`src/main/mcp-endpoint/` · **Touches** `src/server/no-electron.test.ts` only if its
scanner is exported from there for reuse · **Read** `src/server/http.ts`,
`src/server/no-electron.test.ts`, the SDK's stateless Streamable HTTP example.

Guards run before the SDK and answer plain JSON errors: path ≠ `MCP_PATH` → not
handled; any `Origin` header → 403; `Host` not `127.0.0.1:<port>` /
`localhost:<port>` → 403; missing / wrong bearer → 401 (`timingSafeEqual` on
equal-length buffers); body over 8 MiB → 413. Then one low-level SDK `Server` +
`StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request,
closed when the response ends. `tools/list` → `MCP_TOOLS`. `tools/call` → the
registry, with `client` from `CLIENT_HEADER`, `signal` from the SDK's request
handler extra, `progress` → `notifications/progress` when `_meta.progressToken`
is present. `ToolOutcome` ok → `{ content: [{ type: 'text', text }],
structuredContent }`; not ok → `isError: true` with `"<code>: <message>"`.

**Tests** with a stub registry on an ephemeral port and the SDK `Client` +
`StreamableHTTPClientTransport`: list; call; progress received in order; error
outcome → `isError`; cancel aborts `signal`; the five refusals by raw `fetch`;
unknown tool. Closure test: nothing under `src/main/mcp-endpoint/` reaches
`electron`.
**Verify** `npx vitest run src/main/mcp-endpoint/server.test.ts src/main/mcp-endpoint/guards.test.ts`
· gate. **Docs** `mcp-endpoint`.

## WP-5 Shim

**STEPS** S10.2 · **Depends on** WP-1, WP-4 · **Delivers** `src/mcp-shim/index.ts`,
`connect.ts`, `launch.ts`, tests, `vite.mcp-shim.config.ts` · **Touches**
`package.json` (scripts `mcp-shim:build`, and `build` / `prebuild` so `npm run
build` also emits the shim), `tsconfig.node.json` (include), `vitest.config.ts`
only if the spawn test needs a longer timeout · **Read** `vite.server.config.ts`,
WP-0a's findings.

A low-level `Server` on `StdioServerTransport`. `initialize` handled by the SDK;
remember `clientInfo.name`. `tools/list` → `MCP_TOOLS`, no I/O. `tools/call` →
`connect()` then forward through an SDK `Client`, relaying `onprogress` and
cancellation both ways. `connect()`: read `userDataDirFor(process.env, homedir())
/ DISCOVERY_FILE` → `parseDiscovery` → `process.kill(pid, 0)` → connect with the
bearer token and `CLIENT_HEADER`. On `ECONNREFUSED` / 401 / dead pid: drop the
client, re-read once. No usable file: `launch()` — only when `process.execPath`
is inside a `.app` bundle: `open -g -j -a <bundle> --args --background`, poll the
file every 250 ms up to the WP-0a number (default 20 s). Still nothing → a tool
error (`isError`) whose English text says which: *Witena is not running* (dev),
*the MCP endpoint is switched off in Witena → Settings → Integrations* (app up,
no file), or *timed out starting Witena*. Logs go to **stderr only** — stdout is
the protocol. Build: one `out/mcp-shim/witena-mcp.cjs`, `format: 'cjs'`, SDK and
zod inlined, only `node:` builtins external.

**Tests** unit: `connect` against temp dirs (no file, stale pid, wrong version,
re-read after 401); `launch` with injected `spawn` / clock; the bundle-path
derivation. Spawn test (builds the shim in `beforeAll`): `node
out/mcp-shim/witena-mcp.cjs` against a WP-4 endpoint with a stub registry and a
discovery file in a temp `WITENA_USER_DATA` — `tools/list` with no file present;
forwarded call; progress relayed; the endpoint-off error. Closure test: the shim's
import closure contains no `electron`, `better-sqlite3`, or `src/main/`.
**Verify** `npm run mcp-shim:build && ls -la out/mcp-shim/witena-mcp.cjs` ·
`printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | node out/mcp-shim/witena-mcp.cjs`
prints one JSON-RPC result · `npx vitest run src/mcp-shim/` · gate.
**Docs** `mcp-endpoint`; `CLAUDE.md` directory layout and commands table.

## WP-6 Contract test (closes S10.1)

**Depends on** WP-3, WP-4 · **Delivers**
`src/main/mcp-endpoint/contract.test.ts` · **Touches** STEPS.md.

Real `createAppContext` (`:memory:`, mock model), real `buildHandlers()`, real
`createMcpEndpoint` on an ephemeral port, SDK `Client`: create two agents → `list_agents`
→ `start_discussion({ agents: [two names], question })` → `concluded` with the
mock's text → `list_chats` shows the chat → `get_discussion` `transcript` contains
both names → a slow mock + `maxWaitSeconds: 5` → `running`, then
`wait_for_discussion` → final → `stop_discussion` mid-run → `stopped`. Asserts the
status mapping table above, row by row.
**Verify** `npx vitest run src/main/mcp-endpoint/contract.test.ts` · gate. Tick S10.1.

## WP-7 Host and the setting

**STEPS** S10.3 bullet 1 · **Depends on** WP-4 (WP-3 for real tools) · **Delivers**
`src/main/mcp-endpoint/host.ts` + test · **Touches** `src/shared/types.ts`
(`McpEndpointSettings`, defaults, patch), the settings handler / repository merge
and their tests, `src/main/app-context.ts` (`mcpEndpoint: McpEndpointHost | null`
on the context, built when `AppContextOptions.mcpEndpoint = { handlers }` is
given), `src/main/index.ts` (pass the option; `start()` after the context when
enabled; `stop()` in `before-quit`) · **Read** `src/main/handlers/settings.ts`.

Toggling is live: the `settings.update` handler, after storing, calls
`ctx.mcpEndpoint?.start()` / `.stop()` when the patch carried `mcpEndpoint`. The
server host passes no option, so `ctx.mcpEndpoint` is null there. The file is
written only after `listen` resolves, with `mode: 0o600` and a fresh
`randomBytes(32).toString('base64url')` token per `start()`; `stop()` removes it
only if its `pid` is ours.

**Tests** host: start → file exists, mode `0600`, parses, port answers `tools/list`
with the token and 401 without; stop → file gone, port closed; double start / stop;
a foreign-pid file is not deleted. Settings: default false; patch merges; a
context without the option ignores the toggle; with it, toggling starts and stops.
**Verify** `npx vitest run src/main/mcp-endpoint/host.test.ts src/main/handlers/` ·
gate. (The file appearing in a running app is proved by WP-10, not here.)
**Docs** `mcp-endpoint`, `server` (one line: not mounted there yet).

## WP-8 Single instance, background launch, deep link

**STEPS** S10.3 bullets 2–3 · **Depends on** WP-1 (`parseChatUrl`); WP-0a informs
it · **Delivers** `src/main/launch-args.ts` (pure: argv →
`{ background, openChatId }`) + test · **Touches**
`src/main/index.ts`, `src/shared/events.ts` (`UiOpenChatEvent`),
`electron-builder.yml` (`protocols`), the renderer's event wiring and chats store
(select the chat on `ui.open-chat`, through `BackendClient.subscribe`),
`e2e/helpers.ts` only if the lock needs it.

`requestSingleInstanceLock()` immediately after the `WITENA_USER_DATA` override;
losing it → `app.quit()`. `second-instance`: show or create the window, then
handle an `openChatId` in its argv. `--background`: skip `createWindow()` at
ready; `activate` already creates it. `open-url` (registered before `ready`, the
URL buffered until the context exists) → show / create the window → emit
`ui.open-chat`. A link to a chat that does not exist selects nothing and shows no
error. `setAsDefaultProtocolClient('witena')` in packaged builds only.

**Tests** unit: argv parsing (dev argv has extra entries; packaged does not); the
store selecting on the event and ignoring an unknown id. e2e, new
`e2e/launch.spec.ts`: launching with `--background` yields zero windows; two
launches with different user-data dirs both live (the lock is per `userData`).
**Verify** `npx vitest run src/main/launch-args.test.ts src/renderer/src/stores/chats.test.ts`
· `npm run build && npx playwright test e2e/launch.spec.ts e2e/smoke.spec.ts` ·
gate. **Docs** `ui-shell`, `mcp-endpoint`, `packaging` (the `protocols` entry).

## WP-10 End-to-end through the shim

**STEPS** S10.3 tests · **Depends on** WP-5, WP-7 (WP-8 for the last assertion) ·
**Delivers** `e2e/mcp-endpoint.spec.ts` · **Touches** `e2e/helpers.ts` (a helper
that seeds `mcpEndpoint.enabled` before launch, if none fits).

Launch Witena with the endpoint enabled and a temp `WITENA_USER_DATA`; spawn
`node out/mcp-shim/witena-mcp.cjs` with the same env; over the SDK stdio client:
`tools/list`; `list_chats` sees a chat seeded through the backend client;
`start_discussion` on it with `maxWaitSeconds: 5` — the user message appears in
the open window (no model needed: assert the message, accept any status). With
the endpoint disabled the same call returns the switched-off error.
**Verify** `npm run build && npx playwright test e2e/mcp-endpoint.spec.ts` · gate.

## WP-9 Packaging

**STEPS** S10.3 bullet 4 · **Depends on** WP-5, WP-10 · **Delivers**
`build/witena-mcp` (the POSIX launcher, mode 755) · **Touches**
`electron-builder.yml` (`extraResources`: `out/mcp-shim/witena-mcp.cjs` →
`mcp/`, `build/witena-mcp` → `bin/`), `src/main/packaging.test.ts`,
`e2e/packaged.spec.ts`, `src/main/index.ts` (compute `launcherPath` for WP-11:
`process.resourcesPath/bin/witena-mcp` when packaged, else null).

The launcher resolves symlinks to its own real path, derives
`…/Contents/MacOS/Witena` and `…/Contents/Resources/mcp/witena-mcp.cjs`, and
`exec`s with `ELECTRON_RUN_AS_NODE=1`. `sh`, no bashisms, quotes every expansion
(the bundle path may contain spaces).
**Tests** `packaging.test.ts` asserts both `extraResources` entries and that the
launcher is executable in git; `shellcheck` it if available.
**Verify** `npm run dist:dir` ·
`printf '<initialize line from WP-5>\n' | "dist/mac-arm64/Witena.app/Contents/Resources/bin/witena-mcp"`
prints a JSON-RPC result and no Dock icon appears · copy the app to a path with a
space and repeat · `WITENA_APP_PATH=… npm run e2e:packaged` · gate.
**Docs** `packaging`, `mcp-endpoint`. Tick S10.2 / S10.3.

## WP-11 Integrations backend

**STEPS** S10.4 bullet 1 · **Depends on** WP-7, WP-9 (`launcherPath`), WP-0b ·
**Delivers** `src/main/integrations/ide-clients.ts` (the `IdeClients` interface and
the real `node:child_process` implementation), `src/main/handlers/integrations.ts`
+ tests · **Touches** `src/shared/types.ts`, `src/shared/backend.ts`
(+ `BACKEND_METHODS`), `src/main/handlers/index.ts`, `src/main/app-context.ts`
(`ideClients`, `mcpLauncherPath` options), the preload / IPC method list if it is
not derived, the handlers contract test · **Read** how the `ant` / `gcloud`
wrappers locate a binary without the shell's `PATH`.

`IdeClients`: `detect(id)`, `registered(id) → command | null`, `register(id,
command)`, `unregister(id)` — implemented with the exact CLI forms WP-0b recorded,
server name `MCP_SERVER_NAME`, user scope. `connect` also enables the endpoint
(and starts the host) — connecting an IDE to a closed door is never what the user
meant. `stale` = registered command ≠ `launcherPath`. No launcher (dev, server
host) → `connect` rejects with `validation` and a `ValidationReason`; `status`
still answers.
**Tests** handlers with a fake `IdeClients`: not installed; connect → connected +
endpoint enabled; stale detection and repair (connect again); disconnect; no
launcher. The real implementation: argument vectors only, with an injected
`execFile` — never the real CLIs in `npm test`.
**Verify** `npx vitest run src/main/handlers/integrations.test.ts src/main/integrations/`
· gate. **Docs** `mcp-endpoint`, `backend-client`.

## WP-12 Settings → Integrations

**STEPS** S10.4 bullet 2 · **Depends on** WP-11 · **Delivers**
`src/renderer/src/pages/settings/integrations-section.tsx`,
`src/renderer/src/stores/integrations.ts` + test, a pure
`components/settings/integration-display.ts` + test (status → label key / action)
· **Touches** `settings-page.tsx` (the section list), both locale files (new
`settings.integrations.*` keys), `e2e/` (new `integrations.spec.ts`).

The switch with one sentence on what it opens; endpoint status line; a card per
client — not installed / Connect / Connected + Disconnect / Repair; a generic
snippet block (JSON for Claude-style clients, TOML for Codex) with Copy, built
from `launcherPath` and shown even when null (with the dev command and a note).
All copy through `t()`; no component touches `window.witena` (rule 6).
**Tests** store; display mapping for every state; `locales.test.ts` and
`used-keys.test.ts` pass. e2e: open the section, toggle the switch, the discovery
file appears / disappears in the temp user-data dir, the snippet is copied.
**Verify** `npx vitest run src/renderer/src/stores/integrations.test.ts src/renderer/src/components/settings/ src/renderer/src/i18n/`
· `npm run build && npx playwright test e2e/integrations.spec.ts` · gate.
**Docs** `mcp-endpoint` (frontend.md), `i18n`.

## WP-13 Provenance

**STEPS** S10.4 bullet 3 · **Depends on** WP-3, WP-5 · **Touches**
`src/shared/types.ts` (`OriginPart`, `ChatSendInput.origin`),
`src/main/orchestration/chat-runner.ts` (store the part first in `parts`),
the `chat.send` handler validation, `src/main/agents/history.ts` (ignore it —
with a test, as for `ConclusionPart`), `transcript-rows.ts` / `message-item.tsx`
(the "via {{client}}" chip), both locale files (`chat.viaClient`),
`src/main/mcp-endpoint/tools.ts` (pass `call.client`; absent → `'mcp'`) ·
**Read** everything `grep -rn ConclusionPart src` finds: the new part follows the
same path.

`client` is display data from an untrusted header: trim, cap at 40 chars, strip
control characters, in the handler.
**Tests** runner stores the part on the user message only; converter output is
byte-identical with and without it; row model; sanitising; the tool passes it.
**Verify** `npx vitest run src/main/orchestration src/main/agents src/renderer/src/components/chat src/main/mcp-endpoint`
· gate. **Docs** `chats`, `agent-turn`, `mcp-endpoint`, `i18n`. Tick S10.4.

## WP-14 Committees through the endpoint

**STEPS** S10.5 · **Depends on** WP-3, WP-12, **and Phase 9 S9.1 merged into the
integration branch** — check `git log` for it first; if it is absent, stop and
report, do not stub it · **Read** Phase 9's feature folder and handlers; their
names replace every guess below · **Touches** `src/shared/mcp-tools.ts`
(`list_committees`, `committee` on `start_discussion` — the one sanctioned
contract change, made here and nowhere else), `tools.ts`,
`src/main/integrations/` (+ `committee-agents.ts`: the generated subagent files),
`integrations` handlers and section, both locale files.

`start_discussion`: the new-chat form becomes *at least one of `committee`,
`agents`*; the tool resolves the committee by id or name and passes what
`chats.create` expects — expansion, order and de-duplication stay Phase 9's. No
hand-off is ever started; when the expanded chat contains an executor the `hint`
says the caller still applies the conclusion. Subagent files (only if WP-0b item 4
was *confirmed*): `~/.claude/agents/witena-<slug>.md`, frontmatter `name`,
`description`, `tools` (the `mcp__witena__*` names), `generated-by: witena`;
slug = kebab-case ASCII, collisions suffixed with the committee id's first 6
chars. Sync on the integrations toggle and on committee create / rename / delete.
A file without the marker is never written over or removed.
**Tests** as STEPS S10.5 lists, with the home directory injected as a temp dir.
**Verify** `npx vitest run src/main/mcp-endpoint src/main/integrations` · the
contract test extended with `list_committees` → `start_discussion({ committee })`
· gate. **Docs** `mcp-endpoint` and the committee feature.

**Done (2026-09-20), in a reduced scope.** The tools half landed:
`list_committees`, `start_discussion`'s `committee`, the widened refinement, the
prompt argument, and their tests. Phase 9's real names are `committees.list`,
`Committee.memberAgentIds` (ordered), `ChatCreateInput.committeeId` and
`initialMembers()` in `src/main/handlers/chats.ts`; no committee API was added
or changed, because `committees.list` already answers "what would this expand
to". **The subagent-file half is deferred**: its condition — WP-0b item 4
*confirmed* — was not met, the `claude` CLI on this machine is not logged in, so
nothing was written under `~/.claude/`, `src/main/integrations/` was not touched
and no locale key was added. Recorded in STEPS.md S10.5 (still `[~]`, that
bullet annotated), in `context.md` "Open questions", in `implement.md` "Known
limitations" and in S10.7's backlog. `npm run e2e` was not extended: S10.5's e2e
would have driven the deferred UI.

## WP-15 Resources and the prompt

**STEPS** S10.6 · **Depends on** WP-6, WP-5, WP-0b (build only what a client
shows) · **Touches** `src/shared/mcp-tools.ts` (the prompt definition),
`server.ts`, the shim.

`resources/list` → the 20 most recent chats as `witena://chat/<id>`;
`resources/read` → `transcript.ts`'s markdown. `prompts/list` / `prompts/get` →
`consult`. The shim forwards these **only when already connected or a discovery
file exists**; otherwise empty lists — listing must never launch the app.
**Tests** contract tests for both; the shim's no-launch rule (spy on `launch`).
**Verify** `npx vitest run src/main/mcp-endpoint src/mcp-shim` · gate.

## WP-16 README and backlog

**STEPS** S10.7 · **Depends on** everything · **Touches** `README.md`,
`docs/readme/README.zh-CN.md` (kept in step), STEPS.md Phase 6 (the backlog
entries S10.7 lists), `docs/README.md` status column.
**Verify** the README section followed literally on this machine produces a
conclusion in Claude Code; `npm test` (the docs-reading tests) · gate.

*(2026-09-20. Done, except the first half of Verify, which **could not be run
here**: it needs a logged-in `claude` CLI and pressing Connect writes
`~/.claude.json`, which the package was told not to touch. Every claim in the
section was checked against the merged source instead, and the unrun procedure
is the first entry of the backlog the package wrote — STEPS.md Phase 6, "MCP
endpoint (Phase 10)". `docs/README.md` also lost a stale duplicate `packaging`
row while its status column was updated; the duplicated `backend-client`,
`database`, `i18n` and `ui-shell` rows in that table are the same class of merge
artifact and were left alone as outside this package.)*
