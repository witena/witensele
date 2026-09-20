# mcp-endpoint — Backend

> Partly built. Surface by work package (`tasks.md`):

| Surface | Package |
|---|---|
| `src/shared/mcp-tools.ts`, `src/shared/mcp-discovery.ts` | WP-1 `[x]` (2026-09-20) |
| `src/main/mcp-endpoint/discussion.ts` — `watchDiscussion`, `readDiscussion` | WP-2 `[x]` (2026-09-20) |
| `src/main/mcp-endpoint/tools.ts`, `transcript.ts` — the six tools | WP-3 |
| `src/main/mcp-endpoint/server.ts`, `guards.ts`, `tool-types.ts` — transport and refusals | WP-4 `[x]` (2026-09-20) |
| `src/mcp-shim/` and its Vite target | WP-5 |
| `src/main/mcp-endpoint/host.ts`, `AppSettings.mcpEndpoint` | WP-7 |
| Single-instance lock, `--background`, `witena://`, `ui.open-chat` | WP-8 `[x]` (2026-09-20) |
| `bin/witena-mcp` and `mcp/witena-mcp.cjs` in the bundle | WP-9 |
| `integrations.*` handlers over an injected `IdeClients` | WP-11 |
| `OriginPart`, `ChatSendInput.origin` | WP-13 |

Nothing under `src/main/mcp-endpoint/` or `src/mcp-shim/` imports electron; a
closure test in each enforces it (rule 5).

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
