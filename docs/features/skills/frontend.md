# skills — Frontend

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/pages/settings/skills-section.tsx` | Settings → Skills: the 520px card list plus the detail pane, Import and Delete |
| `src/renderer/src/components/settings/skill-card.tsx` | One skill in the list: name, version, tags, description, folder, file count |
| `src/renderer/src/components/agents/skill-checklist.tsx` | The agent form's Skills block, including the rows for names that no longer resolve |
| `src/renderer/src/components/agents/agent-editor.tsx` | Hosts the checklist and binds it to `draft.skillNames` |
| `src/renderer/src/pages/settings-page.tsx` | Renders `SkillsSection` in place of the generic pane, like Providers and MCP servers |
| `src/renderer/src/stores/skills.ts` | The store, plus the pure `missingSkillNames` rule |

The detail pane renders the body with `components/chat/markdown.tsx` — the same
component the transcript uses, so a skill reads in the app exactly as it will
read to the agent.

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| `skills` | `skills` | `SkillMeta[]` | Backend-owned mirror of `userData/skills/` |
| `skills` | `warnings` | `SkillWarning[]` | Folders that look like a skill and could not be used |
| `skills` | `status` | `'idle' \| 'loading' \| 'ready' \| 'error'` | List load state |
| `skills` | `error` / `errorCode` | `string?` / `BackendErrorCode?` | Developer detail plus the code the UI translates |
| `skills` | `selectedName` | `string \| null` | Which skill the detail pane is showing |
| `skills` | `detail` | `SkillDetail \| null` | Its body and file list; `null` while loading |
| `skills` | `importing` | `boolean` | The folder dialog or the copy is in flight |

There is **no draft and no dirty flag**, unlike the provider, MCP and agent
stores: a skill is not edited in the app, so there is nothing to stage.

`missingSkillNames(selected, available)` is exported and pure. It is the rule the
agent form uses to decide whether a bound name is a working binding or a missing
one, and it deliberately matches `enabledSkills` in
`src/main/agents/agent-turn.ts` name for name — the backend skips exactly the
names this function calls missing.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `skills.list` | `SkillsSection` on mount, `AgentEditor` on mount | The library, for the cards and for the checklist |
| `skills.read` | `store.select`, on a card click | The body and file list for the detail pane |
| `system.pickFolder` | `store.importFolder` | The native folder dialog |
| `skills.import` | `store.importFolder` | Copy the chosen folder into the library |
| `skills.delete` | The Delete button's second click | Remove the folder |

No events. The library is edited on one screen by one user, so the store applies
its own writes and nothing else has to be told.

## Interaction states

| State | What the user sees |
|---|---|
| idle | Settings → Skills opens on the list with the intro line above it and the detail pane showing "Select a skill" |
| loading | The list is empty without the empty state (which waits for `status !== 'loading'`); the detail pane shows a spinner and `common.loading` |
| streaming | Not applicable — nothing here streams |
| empty | An `EmptyState` with the Sparkles icon and an Import button inside it. On a fresh installation this is normally *not* what is shown: the bundled skill has been seeded |
| error | A refused import or delete prints one translated line under the list; a skipped folder prints an amber warning line naming the folder and the reason |
| importing | The Import button is disabled and reads "Importing…" |
| delete armed | The Delete button reads "Click again to confirm" until a second click, and disarms when another skill is selected |
| missing (agent form) | The name is listed, checked, dimmed, with a "missing" tag. Unchecking it is how the user removes the dead binding |

## Copy and i18n

New keys under `settings.skills.*`: `intro`, `import`, `importing`, `emptyTitle`,
`emptyDescription`, `selectTitle`, `selectDescription`, `detailIdleTitle`,
`description`, `body`, `files`, `noFiles`, `fileCount`, `deleteConfirm`,
`warningMissingDescription`, `warningUnreadable`.

Under `agents.*`: `skillsEmptyTitle`, `skillsEmptyDescription` (reworded — they
no longer name a future step), `skillFileCount`, `skillMissing`.

`settings.sections.skills` already existed. The two warning strings interpolate
`{{folder}}`; the counts interpolate `{{files}}`.

## Accessibility and keyboard

- The checklist uses native `<input type="checkbox">` inside a `<label>`, so it
  carries the role, the keyboard behaviour and the label association for free —
  the same choice `McpChecklist` made.
- A skill card is one `<button>` with `aria-current` when selected; nothing is
  nested inside it, so it is a single tab stop.
- The Delete button's armed state changes its **label**, not only its colour, so
  the confirmation is not carried by colour alone.
- A warning line is text, not an icon.
