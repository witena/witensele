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
