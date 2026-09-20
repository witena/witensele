# mcp-endpoint — Backend

> Partly built. Surface by work package (`tasks.md`):

| Surface | Package |
|---|---|
| `src/shared/mcp-tools.ts`, `src/shared/mcp-discovery.ts` | WP-1 `[x]` (2026-09-20) |
| `src/main/mcp-endpoint/discussion.ts` — `watchDiscussion`, `readDiscussion` | WP-2 |
| `src/main/mcp-endpoint/tools.ts`, `transcript.ts` — the six tools | WP-3 |
| `src/main/mcp-endpoint/server.ts`, `guards.ts` — transport and refusals | WP-4 |
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
