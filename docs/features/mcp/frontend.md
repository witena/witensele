# mcp — Frontend

## Pages and components

| File | Role |
|---|---|
| `pages/settings/mcp-section.tsx` | Settings → MCP servers: the 520px card list plus the editor column. Like `ProvidersSection`, it supplies **both** columns and carries `settings-section-title` |
| `components/settings/mcp-card.tsx` | One server: name, transport badge, side-effects tag, endpoint, tool count, status pill, enabled switch |
| `components/settings/mcp-display.ts` | Pure: `mcpStatus`, `mcpStatusTone`, `mcpEndpoint`. Unit-tested |
| `components/settings/mcp-editor.tsx` | The add / edit form, the connector gallery above it while the draft is new, the probe result with its tool list, the stderr log, Test / Save / Delete |
| `components/settings/mcp-preset-grid.tsx` | S5.1: the gallery. A two-column grid of `MCP_PRESETS` tiles — name, read-only / changes-things badge, one-line description, runner hint |
| `components/settings/mcp-text.ts` | Pure: `visibleText`, `canonicalArgs`, `canonicalEnv` — what the arguments / environment / headers boxes show. Unit-tested |
| `components/agents/mcp-checklist.tsx` | The agent form's checklist, bound to `mcpServerIds` |
| `components/chat/tool-call.ts` | Gained `serverName` and `label` (`serverName · toolName`) |
| `components/chat/tool-card.tsx` | Renders `label`, and exposes `data-server` next to `data-tool` |
| `stores/mcp.ts` | The whole store |

`pages/settings-page.tsx` routes `section === 'mcp'` to `McpSection` instead of
the generic "not built yet" pane; `components/agents/agent-editor.tsx` replaced
its MCP `EmptyState` with the checklist.

## Store fields (`stores/mcp.ts`)

| Field | Meaning |
|---|---|
| `servers` | Mirror of `mcp_servers`, oldest first |
| `status` / `error` / `errorCode` | List state; a failed load renders as a line, never as a crash |
| `selectedId` / `mode` / `draft` | The editor. `draft` is a `McpServerInput` copy; only `saveDraft` writes |
| `testResults` | Last probe per server id, plus `DRAFT_TEST_KEY` for an unsaved form. **Runtime only** |
| `tools` | Tool list per server id, from `mcp.tools`. **Runtime only** |
| `logs` | stderr tail per server id |
| `testing` / `saving` | Button states |

Pure helpers exported for the editor and for tests: `argsToText` / `textToArgs`
(one argument per line) and `envToText` / `textToEnv` (`KEY=VALUE` per line,
split on the **first** `=` so a value may contain one).

## The connector gallery (S5.1)

`McpPresetGrid` renders `MCP_PRESETS` from `@shared/mcp-presets` directly — the
table is frozen data compiled into the bundle, so there is no `mcp.presets`
method and no loading state. The editor mounts it **only while `mode ===
'create'`**: a tile replaces the command, the arguments, the environment and the
side-effects flag, which is a new registration rather than an edit of the server
on screen.

Picking a tile calls `applyPreset(id)` on the store, which rewrites those fields
and **keeps a name the user has already typed**; an untouched name is filled with
the preset **id** (`github`, not `GitHub`), because the name is also the tool
prefix. Every connection field is written unconditionally, including the ones a
preset does not set, so `custom` after `github` leaves an empty form instead of
GitHub's arguments with the brand name removed.

Two details that follow from the rest of the editor:

- **The line-list boxes need no special case.** `visibleText` already shows the
  draft whenever the typed text can no longer account for it, which is exactly
  what a preset does to `argsText` / `envText`.
- **Which tile is selected is component state** (`presetId` in `McpEditor`),
  reset with the other per-record state when `selectedId` or `mode` changes.
  `McpServer` has no `presetId` column and needs none — nothing downstream asks
  which tile a server came from.

Tile copy: brand names are data and are **not** translated; the `custom` label,
the two badges and the runner hint are keys, and the one-line description is
looked up with the runtime key `settings.mcp.presets.<id>`. `used-keys.test.ts`
cannot see a key built at runtime, so `locales.test.ts` asserts that the set of
description keys in both files is exactly the set of preset ids.

## The line-list boxes

The arguments, environment and headers boxes are edited as raw text, but the
draft stores `args` as `string[]` and `env` as a map — the shapes the backend
validates. The two are **not** kept in a controlled round-trip. Each box owns
its raw text (`argsText` / `envText` in `McpEditor`, reset when `selectedId` or
`mode` changes) and on every change does two things: keeps the text, and
`patchDraft`s the normalised value. The draft is therefore always current, so
Test and Save need no blur step; the box never renders the draft back while the
text still accounts for it.

The reason is that the normalisers are lossy exactly where a half-typed line
lives: `textToArgs` drops empty lines, so the Enter that starts a second
argument is an empty line until its first character arrives; `textToEnv` drops
a line without `=`, so a variable name is nothing until its `=` is typed.
Rendering the draft back on each keystroke erased that newline and put the
caret back on the previous line, which is how `-y` + Enter + `@scope/pkg`
became the single argument `-y@scope/pkg` (found while recording the README
tour; see `docs/features/packaging/implement.md`, "Recording pitfalls").

`visibleText(typed, stored, normalise)` in `mcp-text.ts` decides which of the
two the box shows, with no effect and no reset key: the typed text, as long as
`normalise(typed) === stored`; the stored text otherwise, which is what happens
the moment another server is opened or "Add" starts a fresh draft. The next
keystroke replaces the stale local text. `canonicalArgs` and `canonicalEnv`
are the two `normalise` functions (`argsToText ∘ textToArgs`,
`envToText ∘ textToEnv`).

## Backend calls

| Call | From | When |
|---|---|---|
| `mcp.list` | `McpSection`, `AgentEditor` | On mount |
| `mcp.create` / `mcp.update` / `mcp.delete` | the store | Save, the card's switch, Delete |
| `mcp.testConnection` | `McpEditor` | "Test connection", always against `{ draft }` |
| `mcp.tools` | `AgentEditor` | For the servers this agent is **bound to**, once per id |
| `mcp.log` | `McpEditor` | The first time "Show log" is opened |

`mcp.tools` connects, which for a stdio server spawns a child process. That is
why neither the settings list nor the agent form loads tools for every registered
server: settings shows a count only after a probe the user asked for, and the
agent form asks only for the servers that agent actually uses.

## Interaction states

| State | What the user sees |
|---|---|
| Fresh draft | The connector gallery above the form; Test and Save both disabled until there is a name and a command (or URL) |
| A tile picked | The tile is outlined, the form below is filled in, and the environment box shows the server's variables as `KEY=` lines to complete. The side-effects switch follows the preset, on for GitHub and off for Fetch |
| Editing a saved server | No gallery — only the form |
| Typing a second argument / variable | Enter opens a new line and the caret stays on it; the draft already holds the lines above it |
| Probing | Spinner on the button, "Connecting…" |
| Probe succeeded | A green line with the latency and the tool count, then every tool with its description |
| Probe failed | A red line: the translated `BackendError` plus the raw message in monospace |
| Saved from a draft that was probed | The card shows **connected** with a tool count — the probe result is re-keyed onto the new id rather than thrown away |
| Disabled server | The pill says *disabled* even if the last probe succeeded; the checklist row is greyed with a hint |
| Side-effecting server, participant agent | The checklist row is disabled and explains that only an executor may use it |
| A tool call in a message | A `ToolCard` reading `serverName · toolName(args)`, "running…" then "n results · expand" or "error" |
| A model that cannot use tools | One `notices.toolsUnsupported` system line per chat per agent |

## Test ids

`mcp-preset-<preset id>` (one per tile, carrying `data-side-effects`),
`mcp-add`, `mcp-card` (+ `-select`, `-name`, `-transport`, `-endpoint`, `-tools`,
`-status`, `-side-effects`, `-enabled`), `mcp-editor`, `mcp-name-input`,
`mcp-transport-stdio` / `-http`, `mcp-command-input`, `mcp-args-input`,
`mcp-env-input`, `mcp-url-input`, `mcp-headers-input`, `mcp-side-effects`,
`mcp-enabled`, `mcp-test`, `mcp-test-result` (`data-ok`), `mcp-tool-list`,
`mcp-tool` (`data-tool`), `mcp-show-log`, `mcp-log`, `mcp-save`, `mcp-delete`,
`mcp-error`, `mcp-list-error`; `agent-mcp-list`, `agent-mcp-item`
(`data-server-id`, `data-blocked`), `agent-mcp-checkbox`, `agent-mcp-name`,
`agent-mcp-tools`, `agent-mcp-side-effects`, `agent-mcp-hint`; `tool-card`
(`data-tool`, `data-server`, `data-state`).

## i18n

New keys under `settings.mcp.*` (43), `agents.mcp*` (7) and
`notices.toolsUnsupported`, in both `en.json` and `zh-CN.json`. The
side-effects explanation is the one long string on the page and is a deliberate
paraphrase of the `PLAN.md` decision, not a translation of it.

S5.1 added five more under `settings.mcp.*` — `preset`, `presetHint`,
`presetCustom`, `presetReadOnly`, `presetRequires` (`{{runner}}`) — plus the
`settings.mcp.presets.*` subtree, one description per preset id. The
changes-things badge reuses the existing `sideEffectsTag`, so a tile and a card
say the same word about the same flag. Preset **names** are brand names and stay
out of the locale files.
