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
| `Agent`, `AgentInput`, `AgentParams`, `AgentAvatar`, `AgentRole` | `src/shared/types.ts` | `AgentInput = Omit<Agent, keyof EntityBase>`; `InitialAvatar` gained an optional `textColor` in S2.1 |
| `agents.get / create / update / delete` | `src/shared/backend.ts` | Declared since S1.1; implemented in S2.1 |
| `AgentDraftErrors`, `validateDraft`, `duplicateName` | `src/renderer/src/stores/agents.ts` | Pure, exported, and unit-tested |
| `AGENT_AVATAR_COLORS`, `avatarInitial`, `agentModelLabel` | `src/renderer/src/components/agents/agent-display.ts` | Shared by the Agents page and the chat's member panel |

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
| `params.temperature` | When set: a finite number in `[0, 2]` | `validation` / `temperatureRange` |
| `params.maxTokens` | When set: a positive integer | `validation` / `maxTokensRange` |
| `role` | `participant` or `executor` | `validation` |

The stored name is trimmed; the avatar monogram falls back to the first character
of the name, uppercased, when the user did not type one.

## Tests

| File | Covers |
|---|---|
| `src/main/handlers/agents.test.ts` | Every validation case, case-insensitive uniqueness, the reserved `executor` role, the membership cascade, the `chat.updated` fan-out, and "delete stops a running chat" against a mock model that never finishes |
| `src/renderer/src/stores/agents.test.ts` | `validateDraft`, `duplicateName`, the draft lifecycle (create → save → edit), `dirty` going true and back, a params field being removed rather than set to `undefined`, and the editor closing when its agent is deleted |
| `src/renderer/src/components/agents/agent-display.test.ts` | `agentModelLabel` with and without a provider, `avatarInitial` including an astral-plane character, the palette's size |
| `e2e/agents.spec.ts` | The whole screen: empty library, create, duplicate name refused, a second agent on a second model, duplicate, two-click delete, restart |

## Known limitations and TODOs

- Skills and the memory viewer are still empty states naming S3.2 and S3.3. The
  MCP block became a real checklist in S3.1, bound to `mcpServerIds`; see
  [`../mcp/frontend.md`](../mcp/frontend.md).
- An agent takes **all** of a bound server's tools or none; there is no per-tool
  selection.
- The reasoning toggle writes `params.reasoning`; nothing reads it yet —
  `agent-turn` starts honouring it when a provider that supports it is wired up.
- There is no `agent.created` / `agent.updated` event. The agents page is the only
  writer and patches its own list; other screens learn through `chat.updated`.
- Duplicate copies the provider as well as the model, so "the same agent on
  another model" is two steps.
- The agent list is neither searchable nor groupable. `agents.searchAgents` exists
  as a key for whenever it is.
