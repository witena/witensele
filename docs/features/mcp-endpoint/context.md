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

### Decisions made in WP-2 (the discussion watcher)

| Decision | Alternatives considered | Why this one |
|---|---|---|
| `afterSeq` is a **position** in the chat's ascending transcript, and the module derives the `seq` from it by reading the whole chat through `messages.list` | Adding `seq` to the shared `Message` type; reading `repos.messages` directly | `seq` is deliberately internal to the repository and never crosses IPC, and the endpoint reads through handlers so it can be mounted on the server host later. `seq` is dense — `max(seq) + 1` inside the insert transaction, and no message row is ever deleted on its own — so the two are the same number, and a test pins that against `nextSeq` |
| `watchDiscussion`'s `result` never rejects; `readDiscussion` does | Both throwing; both tolerant | They have different callers. WP-3 calls `cancel()` when `chat.send` throws and never awaits the result, so a rejection there would be an unhandled one; `get_discussion` on a chat id a model invented has to come back as `not_found` rather than as an empty discussion |
| `deadlineMs` is an absolute epoch-millisecond timestamp | A duration in milliseconds or seconds | The caller's budget starts when the tool call arrives, not when the subscription is made, and "a deadline that has already passed" is then a legal input with an obvious meaning instead of a negative duration |
| The result is re-read from the transcript after `run.finished`, never assembled from the events themselves | Accumulating messages from `message.updated` while waiting | Every row is written by the awaited turn before the run can finish, so the store is both complete and authoritative — and the same function then serves `get_discussion`, which has no events to accumulate. It also means the watcher depends on no ordering between `message.updated` and `run.finished` |
| `positions` are each member's last `done` message of the *discussion*, not of the final round | The final round only (STEPS.md's first wording) | A member that was silent in the last round still has a position, and returning nothing for it would read as agreement. Executors are skipped: they write files rather than positions |

## What the spike found

> Filled by WP-0a and WP-0b. Until then every number in this feature that came
> from memory rather than measurement is listed in `tasks.md` under "Assumptions".

## Open questions

- The real names of Phase 9's handlers and types (WP-14 reads them, never guesses).
- Whether Codex surfaces MCP resources or prompts at all (WP-0b); S10.6 drops
  whatever no client shows.
