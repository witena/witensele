# mcp — Context

## Problem

Witena's agents can only talk. Every capability beyond conversation — reading a
repository, searching the web, querying a database — has to come from outside,
and the plan settled on one mechanism for all of it: **MCP servers** (PLAN.md,
"Capability boundaries": *no built-in file / shell / git tools; all capabilities
come from MCP servers*).

This feature is the whole of that mechanism: registering a server in settings,
proving it works, binding it to an agent, discovering its tools, and letting a
turn call them and show what came back.

## Scope

- `McpManager`: a lazily-connected, pooled MCP client per registered server, over
  **stdio** (a child process) and **Streamable HTTP**.
- Tool discovery, and conversion of MCP tools into AI SDK tools.
- Tool execution inside one agent turn, with a per-call timeout, the tool loop
  capped at `MAX_TOOL_STEPS`, and `tool-call` / `tool-result` message parts.
- The **side-effects rule**: a server flagged `sideEffects` is attached to
  `executor` agents only — and, since S5.4, **every** call to one of its tools is
  confirmed through the permission prompt before it runs.
- Settings → MCP servers: CRUD, transport-specific form, test connection with the
  tool list, enable switch, stderr log.
- The agent form's MCP checklist, bound to `agents.mcpServerIds`.
- **The connector gallery** (S5.1): a static table of common servers
  (`src/shared/mcp-presets.ts`) and the tile grid that prefills a new draft from
  one, so registering the GitHub server is a click plus a token.

## Out of scope

| Not here | Who owns it |
|---|---|
| The permission prompt itself — the gate, the two `permission.*` events, `permission.reply` | [`executor`](../executor/context.md), S5.4 `[x]`. This feature supplies the `sideEffects` flag that decides *which* MCP calls are confirmed; the asking is the executor's |
| The executor agent itself and its built-in file / shell / git tools | [`executor`](../executor/context.md), S5.4 `[x]`. This feature only **enforces** the rule that reserves side-effecting tools for it |
| MCP **resources** and **prompts** | Not in the MVP. Only `tools/list` and `tools/call` are used |
| Installing a server (running `npm i`, `uv tool install`, pulling an image) | Nobody. The gallery writes a command line; putting `npx` / `uvx` on `PATH` stays the user's job, and the tile says which runner it needs |
| Keeping a registered server in step with its preset | Nobody. A preset is prefill, not a link: `McpServer` stores no `presetId`, so a package that moves is edited by hand (see "Open questions") |
| `read_skill` / `read_skill_file` | [`skills`](../skills/context.md), S3.2 `[x]` — different tools, same `ToolSet`, and **not** subject to the side-effects rule: they are read-only and confined to `userData/skills/` |
| `memory_save` / `memory_search` | [`memory`](../memory/context.md), S3.3 `[x]` — likewise outside the rule: the only thing they can write is the agent's own notes folder |
| OAuth against an HTTP MCP server | Not in the MVP; the SDK's `authProvider` hook is where it would go |
| Sampling, roots, elicitation (server → client requests) | Not advertised; the client declares no capabilities |

## Dependencies

| Needs | From |
|---|---|
| `mcp_servers` table and its repository | [`database`](../database/context.md) |
| `agents.mcpServerIds`, `agents.role` | [`agents`](../agents/context.md) |
| The turn that attaches and runs the tools | [`agent-turn`](../agent-turn/context.md) |
| `AppSettings.timeouts.toolTimeoutMs` | [`presence`](../presence/context.md) |
| `ToolCallPart` / `ToolResultPart` rendering | [`chats`](../chats/context.md) |
| `BackendClient`, the `mcp.*` methods | [`backend-client`](../backend-client/context.md) |

Depending on this feature in return: `agent-turn` (it calls `ctx.mcp`), and
[`skills`](../skills/context.md) and [`memory`](../memory/context.md), which add
their own tools to the same `ToolSet` through the same `collectAgentTools`.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| Connections are **pooled and lazy** | Connect every server at startup; connect per turn | A stdio server is a child process. Startup would spawn one `npx` per registered server whether or not it is ever used; per-turn would pay seconds of spawn cost on every message |
| The cache holds the **promise**, not the client | Cache the resolved client | Two agents speaking in parallel would otherwise race to create two connections to the same server |
| A failed connection is **evicted** | Keep it and keep failing | A server that was not installed yet, or a laptop that was asleep, must recover without restarting the app |
| Tool keys are `${serverSlug}__${toolName}` | The bare tool name; a dotted name | The model sees one flat namespace and two servers may both offer `search`. `[a-zA-Z0-9_-]` is the intersection of what providers accept — a dot or a space is rejected outright |
| The transcript stores the **original** tool name plus `serverId` / `serverName` | Store the prefixed key | The prefix is our bookkeeping. A user reading a transcript wants `everything · echo`, and a renamed server must not rewrite history |
| An MCP result is flattened to **text** | Pass the content blocks through as JSON | Every provider accepts a string tool result; only some accept structured content. Images become `[image <mime>]` rather than base64 — the MVP has no vision path and the payload would swamp the context |
| `isError: true` **throws** | Return it as a normal result | The AI SDK then emits a `tool-error` part, so the model is told the call failed instead of being fed an error message it may read as data |
| `testConnection` uses a **fresh** client | Reuse the pool | It usually probes an unsaved draft, must leave no process behind, and must not disturb a connection an agent is mid-call on |
| `mcp.testConnection` takes a `McpServerRef` | Take an id | "Test" has to work before "Save", exactly as it does for a provider key. Saving first would leave broken rows behind |
| stdio children inherit `process.env` | Inherit the SDK's `DEFAULT_INHERITED_ENV_VARS`; inherit nothing | `npx`, `uvx` and `docker` need `PATH`, `HOME`, `NODE_*` and proxy variables. A registered server already runs an arbitrary command by design, so there is nothing left to protect by stripping variables (see `backend.md`, "Security posture") |
| stderr is kept in a **ring buffer** | Log to the app's stderr; drop it | "Could not connect" is not a diagnostic. The real reason (missing package, wrong path) is on the child's stderr and nowhere else |
| The side-effects rule is enforced in `collectAgentTools` | Enforce in the handler; enforce in the UI | The UI explains it and the handler never sees a turn. The one place every tool must pass through is where the turn assembles them |
| S5.4's **confirmation** is attached in the same place — the `call` closure `collectAgentTools` builds — rather than inside `mcp/tools.ts` | Ask inside `toAiTools`; ask inside `McpManager.callTool` | `tools.ts` is pure and knows nothing about a chat, and the manager is a connection pool. Attaching it at the same seam means the flag that decides *whether an agent may have a tool* and the flag that decides *whether a call is confirmed* are read in one place from one record |
| **Every** tool of a flagged server asks, not just the ones whose names sound dangerous | Ask per tool name; let the server annotate its own tools | The flag is the server's own declaration that its tools change the world. This layer cannot tell `create_issue` from `list_issues`, and guessing wrong in that direction is silent |
| A model that cannot use tools gets **one retry without them** | Fail the turn; never attach tools to small models | Answering without tools beats answering nothing, and which local models support tool calling cannot be known ahead of time |
| Tool counts are fetched **on demand**, never on page load | Load every server's tools when settings opens | `mcp.tools` connects; a settings page that spawns six `npx` processes on open is a page that is wrong to open |
| The arguments / environment boxes own their **raw text**; the draft stores the normalised list | Render the draft back into the box on every keystroke; normalise only on blur | The normalisers drop empty lines and `=`-less lines, so a round-trip erased the Enter that starts a second argument. Blur-only would leave the draft stale while Test and Save read it |
| The gallery is **static data in `src/shared/`** | A `mcp.presets` backend method; a registry fetched from the MCP servers repository | A frozen array compiled into the bundle needs no loading state and works offline. Fetching a live registry is a different feature (trust, signatures, versions) and would make "Add server" fail when the network does |
| A preset's `env` values are **empty strings** | Omit `env` and explain the variables in the description; ship placeholder values | An empty value is what makes the environment box open with `GITHUB_PERSONAL_ACCESS_TOKEN=` already on a line: the user fills in the half that is secret. A placeholder value would be indistinguishable from a real one after Save |
| A preset writes the **id** into an untouched name | Write the display name (`Brave Search`) | The name is also the tool prefix an agent sees (`everything__echo`), and `${slug}__${tool}` sanitizes anything else into something the user never typed |
| The gallery is shown for a **new draft only** | Show it when editing too, as the provider editor does | A tile replaces the command, the arguments, the environment and the side-effects flag — that is a new registration, not an edit. The provider editor can afford it because a provider preset only changes an endpoint and a model list |
| Which tile was picked is **view state in the editor** | An `mcp_servers.preset_id` column, like `Provider.presetId` | Nothing downstream needs it: there is no logo to pick again and no "local server" rule to derive. A column would be a migration that buys an outline |
| A second grid component rather than a generalised `preset-grid.tsx` | Widen the provider grid with optional badge / hint / description slots | A connector tile answers "what does this do and will it change anything"; a provider tile is a monogram and a brand. One component would have meant six optional slots and would have dragged the providers feature into this step. The duplication is a border and a focus ring |

## Open questions

- **`notifications/tools/list_changed` is ignored.** The tool list is cached for
  the life of a connection and refreshed only on request. A server that adds
  tools at runtime will not be noticed until reconnection. The SDK's
  `listChanged` handler is where that would be wired.
- **No per-tool selection.** An agent gets all of a server's tools or none. A
  server with forty tools spends a lot of context on definitions; per-tool
  checkboxes are the obvious next step if that becomes a problem in practice.
- **`MAX_TOOL_STEPS = 8` is a guess.** It has not yet been tuned against a real
  multi-step task.
- **Preset command lines age.** A package that is renamed or archived makes an
  entry wrong, and because no server remembers which preset it came from, a
  registered server never learns about the correction. Everything a preset writes
  is visible in the form before Save, so the failure mode is a probe that fails
  with a clear npm error rather than a silent misconfiguration — but a gallery
  that is checked against reality (a test that actually spawns each one) is the
  obvious next step, and it is not cheap: it downloads ten packages.
- **`McpPreset.docsUrl` is data nobody renders yet.** It is the same state
  `ProviderPreset.docsUrl` has been in since S1.6. The tile is the natural home
  for a "documentation" link, which needs one more key and an external-link
  affordance the settings pages do not have yet.
