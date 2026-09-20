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

## What the spike found

> Filled by WP-0a and WP-0b. Until then every number in this feature that came
> from memory rather than measurement is listed in `tasks.md` under "Assumptions".

## Open questions

- The real names of Phase 9's handlers and types (WP-14 reads them, never guesses).
- Whether Codex surfaces MCP resources or prompts at all (WP-0b); S10.6 drops
  whatever no client shows.
