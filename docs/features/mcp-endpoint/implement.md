# mcp-endpoint — Implementation

> Partly built: WP-1's contracts and WP-8's launch handling are in the tree;
> everything under `src/main/mcp-endpoint/` and `src/mcp-shim/` is still to come. The design is
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

A fourth piece is not a layer but a handful of lines in the Electron entry:
**how the app is started and how a link gets back into it** (WP-8,
`src/main/launch-args.ts` plus `src/main/index.ts`). It is the only part of this
feature that is allowed to import electron, which is exactly why it lives
outside `src/main/mcp-endpoint/` — see "Launch, lock and deep link" below.

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

## Tests

| File | Covers |
|---|---|
| `src/shared/mcp-tools.test.ts` | The wire shape of every `inputSchema`; names against `MCP_TOOL_NAMES`; `start_discussion`'s three refinements; the wait and round bounds; `chatUrl` / `parseChatUrl`; the `z.infer` type test; that the module imports `zod` and nothing else |
| `src/shared/mcp-discovery.test.ts` | Every way the discovery file can be wrong; `userDataDirFor` with and without the override; that the module stays pure |
| `src/main/launch-args.test.ts` | Both argv shapes, the accepted and rejected link forms, and the scheme pin (WP-8) |
| `src/renderer/src/stores/chats.test.ts` | `describe('ui.open-chat')`: select, ignore, hold until the list lands, drop (WP-8) |
| `e2e/launch.spec.ts` | `--background` yields no window and `activate` still opens one; a link opens one; two `WITENA_USER_DATA` directories coexist (WP-8) |

## Known limitations and TODOs

Listed in STEPS.md S10.7's backlog bullet.
