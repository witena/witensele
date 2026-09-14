# agents — Implementation

## Approach

Five handlers over the existing `AgentRepository`, and one page built from a
zustand store that keeps an **editor draft** — the same shape `providers` uses,
for the same reason: a record that cannot be saved field by field.

The one piece of real logic in the backend is deletion, because it is the only
agent operation whose effects leave its own row.

## Data flow

### Creating or editing an agent

```
"+"  or a click on a list row
  → stores/agents.ts  startCreate() / startEdit(id)      (draft = AgentInput copy)
  → the editor's controls           patchDraft / patchParams / pickAvatarColor
  → validateDraft(draft, agents, selectedId)             (Save enabled?)
  → Save   saveDraft()
  → BackendClient.invoke('agents.create' | 'agents.update')
  → handlers/agents.ts  assertAgentInput / assertAgentPatch
  → repos.agents.create / update                         (SQLite)
  ← Agent                                                (store list patched,
                                                          draft re-seeded, dirty=false)
```

`agents.update` additionally emits one `chat.updated` per chat the agent is in,
so the member panel and the message headers pick up a rename or a model change
without a second round trip.

### Deleting an agent

```
Delete (first click arms, second acts)
  → BackendClient.invoke('agents.delete', { id })
  → handlers/agents.ts
      repos.chats.listChatIdsForAgent(id)        which chats are affected
      runners.stop(chatId) for each              a streaming turn is aborted first
      repos.agents.delete(id)                    chat_members cascades
      emit chat.updated for each affected chat
  ← void                                         (store drops the row, editor closes)
```

## Key types and contracts

| Name | Where | Notes |
|---|---|---|
| `Agent`, `AgentInput`, `AgentParams`, `AgentAvatar`, `AgentRole` | `src/shared/types.ts` | `AgentInput = Omit<Agent, keyof EntityBase>`; `InitialAvatar` gained an optional `textColor` in S2.1. `AgentRole` stopped being reserved in S5.2, and its doc comment is where PLAN.md's one-writer decision is restated |
| `isExecutor`, `hasExecutor` | `src/renderer/src/components/agents/agent-display.ts` | The badge's rule and the member picker's, in one place. Pure and unit-tested |
| `agents.get / create / update / delete` | `src/shared/backend.ts` | Declared since S1.1; implemented in S2.1 |
| `AgentDraftErrors`, `validateDraft`, `duplicateName` | `src/renderer/src/stores/agents.ts` | Pure, exported, and unit-tested |
| `AGENT_AVATAR_COLORS`, `avatarInitial`, `agentModelLabel` | `src/renderer/src/components/agents/agent-display.ts` | Shared by the Agents page and the chat's member panel |
| `AgentTemplate`, `AGENT_TEMPLATES`, `getAgentTemplate`, `suggestedModel` | `src/shared/agent-templates.ts` | S7.5. Static data like `presets.ts` and `mcp-presets.ts`: no electron, no node, imported by the renderer directly. The **name and the system prompt are stored content** and are English literals here, exactly like `DEFAULT_AGENT_NAME`; only the one-line description is copy, under `agents.templates.<id>` in both locale files |

## Validation rules

The handler is the authority; the store computes the same rules so Save can be
disabled with a reason.

| Field | Rule | Error |
|---|---|---|
| `name` | Non-empty after trimming | `validation` / `nameRequired` |
| `name` | No `@` anywhere (S2.3 parses mentions) | `validation` / `nameAt` |
| `name` | Unique per user, case-insensitive, trimmed | `validation` / `nameTaken` |
| `providerId` | Non-empty **and** an existing provider | `validation` / `not_found` |
| `modelId` | Non-empty after trimming | `validation` / `modelRequired` |
| `params.temperature` | When set: a finite number in `[0, 2]` | `validation` (handler only) |
| `params.maxTokens` | When set: a positive integer | `validation` (handler only) |
| `role` | `participant` or `executor` | `validation` |

The last two rows are **handler-only** since S5.9: the form no longer has a
Temperature or a Max tokens box, so `validateDraft` says nothing about them and
the two `agents.validation.*` messages are gone from both locale files. The
handler keeps the bounds, because a future API caller is not this UI, and the
fields stay on `AgentParams` so an agent saved before S5.9 keeps its values.

Since S5.2 the form writes both roles. The handler's rule is unchanged — it
always accepted either — and nothing about `role` is validated *against a chat*
here; that is `chats.members.set`'s job (see
[`../chats/backend.md`](../chats/backend.md)).

The stored name is trimmed; the avatar monogram falls back to the first character
of the name, uppercased, when the user did not type one.

## Tests

| File | Covers |
|---|---|
| `src/main/handlers/agents.test.ts` | Every validation case, case-insensitive uniqueness, the reserved `executor` role, the membership cascade, the `chat.updated` fan-out, and "delete stops a running chat" against a mock model that never finishes |
| `src/renderer/src/stores/agents.test.ts` | `validateDraft` (including that it says nothing about `temperature` / `maxTokens` since S5.9), `duplicateName`, the draft lifecycle (create → save → edit), `dirty` going true and back, a params field being removed rather than set to `undefined`, a stored temperature surviving an edit untouched, and the editor closing when its agent is deleted |
| `src/shared/agent-templates.test.ts` | S7.5's invariants: two or three entries, unique ids and names (a clash would make the second tile fail on click), a name every `@mention` rule accepts, an English prompt and description, lowercase model hints, a palette index the editor offers — plus `suggestedModel` preferring the earliest matching hint, matching case-insensitively, falling back to the provider's first model and answering `undefined` for none |
| `src/renderer/src/stores/agents.test.ts` (S7.5) | `createFromTemplate`: the template written verbatim on the model its hints prefer, the editor left closed, nothing written when there is no model or no provider, the `<name> copy` rename when the name is taken, and each template landing on a different avatar colour |
| `src/renderer/src/components/agents/agent-display.test.ts` | `agentModelLabel` with and without a provider, `avatarInitial` including an astral-plane character, the palette's size, and `isExecutor` / `hasExecutor` over an empty list, a list of participants and a mixed one |
| `e2e/agents.spec.ts` | The whole screen: empty library, create, the absence of the S5.9 sampling fields, duplicate name refused, a second agent on a second model, duplicate, two-click delete, restart |
| `e2e/executor.spec.ts` | S5.2: the role control writing `executor` and surviving a save and a restart, the explanation rendered under it, and the badge appearing in the agent list for the executors and only for them. The rest of that spec is [`chats`](../chats/implement.md)'s half of the step |

## Known limitations and TODOs

- The editor's three capability blocks are all real now: MCP from S3.1
  ([`../mcp/frontend.md`](../mcp/frontend.md)), Skills from S3.2
  ([`../skills/frontend.md`](../skills/frontend.md)) and Memory from S3.3
  ([`../memory/frontend.md`](../memory/frontend.md)).
- A bound `skillName` whose folder is gone stays on the record on purpose, tagged
  "missing" in the editor: the name is what the user would re-import it under, so
  dropping it would silently unconfigure the agent. `mcpServerIds`, which are
  ids, *are* unbound by `mcp.delete` — the two differ because the identifiers do.
- An agent takes **all** of a bound server's tools or none; there is no per-tool
  selection.
- The reasoning toggle writes `params.reasoning`; nothing reads it yet —
  `agent-turn` starts honouring it when a provider that supports it is wired up.
- `params.temperature` and `params.maxTokens` are **stored and honoured but no
  longer editable** (S5.9). `agent-turn` still spreads them into `streamText` and
  `fitHistory` still reserves `maxTokens` when one is set, so an agent configured
  before S5.9 is unchanged; there is simply no screen that writes either, and no
  way to clear one that is already there short of `agents.update`.
- **The role is real but half-used.** It already gates the `sideEffects` MCP
  checklist (S3.1) and the "one executor per chat" rule (S5.2); the executor's
  own file, shell and git tools arrive in S5.4, so an `executor` in a chat with
  no `workdir` behaves exactly like a participant today.
- Promoting an agent to `executor` is not refused when it is already in a chat
  that has one. See [`../chats/backend.md`](../chats/backend.md).
- There is no `agent.created` / `agent.updated` event. The agents page is the only
  writer and patches its own list; other screens learn through `chat.updated`.
- Duplicate copies the provider as well as the model, so "the same agent on
  another model" is two steps.
- The agent list is neither searchable nor groupable. `agents.searchAgents` exists
  as a key for whenever it is.
