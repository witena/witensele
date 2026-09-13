# agents — Frontend

## Files

| File | What it is |
|---|---|
| `src/renderer/src/pages/agents-page.tsx` | The two columns: the 264px list and the editor. Owns the three loads it needs and the "Delete is armed" view state |
| `src/renderer/src/components/agents/agent-list.tsx` | The mockup's `.agent-item` rows: avatar, name, the `executor` chip, `modelId · provider` in mono. Takes `executorLabel` as an already-translated prop, so the row stays free of i18next |
| `src/renderer/src/components/agents/agent-editor.tsx` | The header (avatar, name, "in N chats", Duplicate / Delete / Save) and the two-column body, including the S5.2 role control and the explanation under it |
| `src/renderer/src/components/agents/agent-display.ts` | Pure helpers: the avatar palette, `avatarInitial`, `agentModelLabel`, and `isExecutor` / `hasExecutor`. Shared with the chat's member panel, its picker and the message header |
| `src/renderer/src/stores/agents.ts` | The list, the editor draft, validation |

## Store fields (`useAgentsStore`)

| Field | Meaning |
|---|---|
| `agents` | Backend-owned mirror of the table, oldest first |
| `status`, `error`, `errorCode` | Load state and the last failure (`errorCode` picks the `errors.*` copy) |
| `selectedId` | The agent the editor is bound to; `null` while creating |
| `mode` | `idle` (placeholder), `create`, `edit` |
| `draft` | The editor's `AgentInput` working copy, or `null` when closed |
| `dirty` | Whether the draft differs from what is stored. Always `true` while creating |
| `saving` | A `create` / `update` round trip is in flight |

Actions: `load`, `create`, `update`, `remove`, `duplicate`, `startCreate`,
`startEdit`, `closeEditor`, `patchDraft`, `patchParams`, `pickAvatarColor`,
`saveDraft`, `draftErrors`.

`patchParams` accepts `undefined` for a field, which **removes** it — under
`exactOptionalPropertyTypes` an absent key and a key holding `undefined` are
different types, and "clear the temperature box" has to be spellable.

## Backend calls

| Action | Method |
|---|---|
| Page mount | `agents.list`, `providers.list`, `chats.list` (+ one `chats.members.list` per chat, for the "in N chats" line) |
| Save (new) | `agents.create` |
| Save (existing) | `agents.update` |
| Duplicate | `agents.create` with a free name |
| Delete | `agents.delete` |

## Interaction states

| State | What the screen shows |
|---|---|
| Empty library | The list's `EmptyState`; the editor's "select or create an agent" placeholder |
| New draft | The form, Save disabled, `agents.validation.nameRequired` under the name field |
| Invalid field | The message under that field; Save stays disabled |
| Clean draft | Save disabled because nothing changed |
| Saving | Save disabled while the round trip is in flight |
| Delete armed | The Delete button's label becomes "click again to confirm" until the next click or a selection change |
| No providers | The provider select shows its placeholder and `agents.noProviders` points at Settings |
| Provider with no model list | The model control is a text field plus `agents.modelManualHint` |
| Role | A two-segment control (`Participant` / `Executor`) with `agents.roleHint` under it. Picking `Executor` immediately un-greys the `sideEffects` rows in the MCP checklist below, which is the whole point of the two controls sharing a screen |
| Load or save failure | `agents-error` under the list, translated by `i18n/errors.ts` |

## Test ids

`page-agents`, `agents-new`, `agent-item` (`data-agent-id`, `data-selected`),
`agent-item-name`, `agent-item-model`, `agent-editor-name`, `agent-duplicate`,
`agent-delete`, `agent-save`, `agent-name`, `agent-name-error`,
`agent-avatar-swatch`, `agent-description`, `agent-role-participant`,
`agent-role-executor`, `agent-role-hint`, `agent-item-executor`,
`agent-provider`, `agent-model`,
`agent-model-input`, `agent-temperature`, `agent-max-tokens`,
`agent-system-prompt`, `agents-error`, `agent-skill-item` (with `data-skill` and
`data-missing`), `agent-skill-checkbox`, `agent-memory-toggle`, `memory-index`,
`memory-entry`, `memory-content`, `memory-save`, `memory-delete`.

## Deviations from the artboard

- The avatar control is a row of eight colour swatches next to a live preview,
  where the artboard draws a single field reading "letter · warm brown". The
  artboard's version has no way to actually pick anything.
- The Skills block *is* the artboard's checkbox list from S3.2
  (`components/agents/skill-checklist.tsx`), bound to `skillNames`, with an extra
  row per bound name the library can no longer resolve — tagged "missing" rather
  than dropped, because skills are referenced by name.
- The memory block is the toggle plus `components/agents/memory-panel.tsx` from
  S3.3: the entry list, an editable `MEMORY.md` and note, and per-note delete,
  where the artboard drew a static excerpt.
- The MCP block *is* the artboard's checkbox list from S3.1
  (`components/agents/mcp-checklist.tsx`): one row per registered server with its
  transport, its tool count and its side-effects tag, bound to `mcpServerIds`. A
  `sideEffects` server is greyed out with a hint on a `participant` agent, since
  only an `executor` is ever given those tools.
- "Reasoning" is a `Toggle` rather than the artboard's select, because the stored
  value is a boolean.
- The role control is not on the artboard at all: it was drawn before the
  executor existed. It sits at the end of the "Basic info" block, above the
  model, because it says *what this agent is* rather than *how it runs*.
