# mcp — Frontend

## Pages and components

| File | Role |
|---|---|
| `pages/settings/mcp-section.tsx` | Settings → MCP servers: the 520px card list plus the editor column. Like `ProvidersSection`, it supplies **both** columns and carries `settings-section-title` |
| `components/settings/mcp-card.tsx` | One server: name, transport badge, side-effects tag, endpoint, tool count, status pill, enabled switch |
| `components/settings/mcp-display.ts` | Pure: `mcpStatus`, `mcpStatusTone`, `mcpEndpoint`. Unit-tested |
| `components/settings/mcp-editor.tsx` | The add / edit form, the probe result with its tool list, the stderr log, Test / Save / Delete |
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
| Fresh draft | Test and Save both disabled until there is a name and a command (or URL) |
| Probing | Spinner on the button, "Connecting…" |
| Probe succeeded | A green line with the latency and the tool count, then every tool with its description |
| Probe failed | A red line: the translated `BackendError` plus the raw message in monospace |
| Saved from a draft that was probed | The card shows **connected** with a tool count — the probe result is re-keyed onto the new id rather than thrown away |
| Disabled server | The pill says *disabled* even if the last probe succeeded; the checklist row is greyed with a hint |
| Side-effecting server, participant agent | The checklist row is disabled and explains that only an executor may use it |
| A tool call in a message | A `ToolCard` reading `serverName · toolName(args)`, "running…" then "n results · expand" or "error" |
| A model that cannot use tools | One `notices.toolsUnsupported` system line per chat per agent |

## Test ids

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
