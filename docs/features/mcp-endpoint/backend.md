# mcp-endpoint — Backend

> Partly built. Surface by work package (`tasks.md`):

| Surface | Package |
|---|---|
| `src/shared/mcp-tools.ts`, `src/shared/mcp-discovery.ts` | WP-1 `[x]` (2026-09-20) |
| `src/main/mcp-endpoint/discussion.ts` — `watchDiscussion`, `readDiscussion` | WP-2 `[x]` (2026-09-20) |
| `src/main/mcp-endpoint/tools.ts`, `transcript.ts` — the six tools | WP-3 |
| `src/main/mcp-endpoint/server.ts`, `guards.ts` — transport and refusals | WP-4 |
| `src/mcp-shim/` and its Vite target | WP-5 |
| `src/main/mcp-endpoint/host.ts`, `AppSettings.mcpEndpoint` | WP-7 |
| Single-instance lock, `--background`, `witena://`, `ui.open-chat` | WP-8 |
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
