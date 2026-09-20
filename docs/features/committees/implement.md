# committees — Implementation

## Approach

Three layers, each the ordinary shape of its neighbours:

- **Storage.** `committees` and `committee_members` in both dialects, plus the
  nullable `chats.committee_id`. `src/main/db/repositories/committees.ts` maps
  the row and its join rows onto the single shared `Committee` type:
  `memberAgentIds` is part of the entity, so `create` and `update` write both
  tables inside one `db.transaction`.
- **Handlers.** `src/main/handlers/committees.ts` validates and delegates. The
  only rule it does not own is the executor rule, which it imports from
  `handlers/chats.ts` so a committee and a chat refuse the second executor with
  the same code and the same `second_executor` reason.
- **Convening.** `chats.create` is the one place the two features meet: given a
  `committeeId` it reads the committee **once**, merges its members with the
  caller's extras, and stores the id on the chat as provenance. Nothing reads
  the committee afterwards — that is what makes joining a snapshot. Since S10.5
  it has a second caller: the MCP endpoint's `start_discussion`, which resolves
  a committee by name or id and passes `committeeId` here rather than expanding
  anything of its own.
- **The page (S9.2).** `stores/committees.ts` on `stores/agents.ts`' pattern —
  a `CommitteeInput` draft, `dirty`, and one write on Save — and
  `pages/committees-page.tsx` on the Agents page's layout. The member list is
  edited *in the draft*, never through a call of its own, because membership
  rides on the entity; `addMember` / `removeMember` / `moveMember` are all
  `patchDraft`.

  The two interactions the list needs already existed in the member panel, so
  S9.2 **extracted** them rather than writing a second copy:
  `components/agents/agent-picker.tsx` (the candidate popover, with the
  one-executor rule and its `chat.executorTaken` explanation) and
  `components/ui/reorderable-list.tsx` (the draggable rows). Both are shaped by
  what the member panel must keep: the picker leaves the open state, the
  outside-click and the positioning to its caller, and the list renders no
  container element, so the panel's DOM, classes and test ids are byte for byte
  what they were and `e2e/members.spec.ts` needed no edit.

- **Convening it (S9.3).** `components/chat/new-chat-dialog.tsx` over a new
  `components/ui/dialog.tsx`, with the dialog's open state in `stores/ui` so
  the Committees page can open it across a navigation. The dialog composes
  three choices into one `chats.create`, and sends only the **extras** — the
  committee expansion stays the handler's job, because a renderer that sent the
  expanded list would be asserting a snapshot the backend is supposed to take.
  What the renderer *does* duplicate is the merge rule, as
  `lib/committee-members.ts`, and only to count: the live "n members will join"
  line and the ticked, locked rows both need the answer before the call.

  The same file answers the other half of the snapshot. `missingCommitteeMembers`
  is what the member panel's "Sync committee members" is drawn from — committee
  members this chat never got, in committee order — and the button writes
  `chats.members.set` with the chat's current list plus those appended. It
  cannot remove anyone, by construction rather than by policy.

Orchestration, `AgentTurn` and the supervisor are untouched: they read
`chat_members`, which now simply has members in it sooner.

## Data flow

Convening a topic. Since S9.3 the New chat dialog drives it, and since S10.5 the
MCP endpoint's `start_discussion` drives the *same* call from an IDE:

```
chats.create({ committeeId, memberAgentIds })
  → assertChatPatch / assertAgentIds / committeeId is a non-empty string
  → initialMembers(ctx, committeeId, memberAgentIds)
        repos.committees.get(committeeId)      → not_found if it is gone
        [...committee.memberAgentIds, ...extras], first occurrence wins
        empty list + empty library → ensureDefaultAgent (unchanged)
  → assertOneExecutor(merged)                  → validation / second_executor,
                                                 before the row exists
  → repos.chats.create({ …patch, committeeId })
  → repos.chats.setMembers(chat.id, merged)    → positions 0…n from the array
  → emit chat.updated
```

Editing a committee (S9.2's save):

```
committees.update({ id, patch })
  → repos.committees.get(id)        → not_found before the patch is measured
  → name trimmed / within the cap; every member an existing agent; no
    duplicates; at most one executor
  → one transaction: UPDATE committees, DELETE then INSERT committee_members
  → the caller gets the re-read entity, members in position order
```

Convening one from the UI (S9.3). Two entry points, one dialog:

```
"+" on the chat list      → ui.openNewChatDialog()
"New topic" on a committee → ui.openNewChatDialog(id) then ui.setPage('chats')
                             ↑ open first: this component is unmounted by the
                               page change, and ChatsPage reads the request on
                               mount

NewChatDialog mounts        committeeId = seed, extras = [], title = ''
  pick a committee        → single select; picking again clears it, and extras
                            the committee brings (or an executor it collides
                            with) are dropped rather than left to be refused
  tick an agent           → extras; a committee member's row is locked
  mergeMembers(…)         → the ticks, the greyed-out executors and the count
Create                    → chats.create({ title?, committeeId?, extras })
     ↳ refused            → the panel stays open, `new-chat-error` inside it
     ↳ created            → applyUpdated + select + closeNewChatDialog
```

Closing the drift (S9.3):

```
ChatsPage renders          missingCommitteeMembers(committee, memberIds)
  non-empty               → member-sync-committee, with the count
  click                   → chats.members.set(chatId, [...members, ...missing])
                            append only; the existing order is untouched
     ↳ second_executor    → the usual error line under the chat list
```

Deleting a committee:

```
committees.delete({ id })
  → repos.chats.listChatIdsForCommittee(id)   ← read *before* the delete
  → DELETE committees            → committee_members cascade,
                                    chats.committee_id → NULL
  → one chat.updated per affected topic
```

Building one on the page (S9.2). Nothing is written until Save, and Save writes
the record and its members together:

```
CommitteesPage mounts
  → committees.list / agents.list / providers.list / chats.list
"+"  → startCreate()                   draft = { name: '', description: '',
                                                 memberAgentIds: [] }, dirty
Add  → AgentPicker → addMember(id)     patchDraft, order = click order
drag │ ▲ ▼ → moveMember(from, to)      patchDraft, via lib/reorder
Save → validateDraft(draft)            name trimmed, non-empty, within the cap
     → committees.create | update      the one call; members ride along
     → mode = 'edit' on the new row    the user usually keeps editing
     ↳ refused → errorCode + errorDetails → translateFailure → one line
Delete (twice) → committees.delete     the topics keep their members
```

## Key types and contracts

In `src/shared/types.ts`:

| Type | Shape |
|---|---|
| `Committee` | `EntityBase & { name: string; description: string; memberAgentIds: string[] }` — the array is **ordered**, and that order is the speaking order a chat inherits |
| `CommitteeInput` | `Omit<Committee, keyof EntityBase>` |
| `CommitteePatch` | `Partial<CommitteeInput>`; an absent field is left alone, `memberAgentIds` replaces the whole list |
| `MAX_COMMITTEE_NAME_CHARS` | `100` |
| `Chat.committeeId` | `string \| null` — provenance, not membership |
| `ChatCreateInput.committeeId` | `string \| undefined`; deliberately **absent** from `ChatPatch` |

| Channel / method | Request | Response | Notes |
|---|---|---|---|
| `committees.list` | — | `Committee[]` | Newest `updatedAt` first |
| `committees.get` | `{ id }` | `Committee` | `not_found` for an unknown id |
| `committees.create` | `{ input: CommitteeInput }` | `Committee` | Name trimmed before it is stored |
| `committees.update` | `{ id, patch: CommitteePatch }` | `Committee` | |
| `committees.delete` | `{ id }` | `void` | Topics keep their members; `Chat.committeeId` becomes `null` |
| `chats.create` | `{ input: ChatCreateInput }` | `Chat` | Now also takes `committeeId` |

| Event | Payload | Emitted when |
|---|---|---|
| `chat.updated` | `{ chat }` | `committees.delete`, once per topic that lost its committee |

No `committee.*` event exists: the Committees page owns the committee list it is
editing, and the only committee change the *rest* of the app can see is a chat's
provenance, which `chat.updated` already carries.

## Tests

| File | Covers |
|---|---|
| `src/main/db/committees.test.ts` | Create with an order, reopen with it intact, replace on update (reorder and removal), a patch that does not mention members, `updatedAt desc` ordering, duplicate and unknown-agent refusals writing nothing, a deleted agent dropping out with the position gap closed on read, a deleted committee leaving its topic's members intact and `committeeId` null, a pre-Phase-9 chat reading `null`, `not_found` on get / update / delete |
| `src/main/handlers/committees.test.ts` | CRUD through the handlers with the name trimmed, blank / over-cap names, unknown and duplicate members, the `second_executor` refusal on create and on update (which changes nothing), `not_found` on all three id methods, and one `chat.updated` per topic when a committee is deleted |
| `src/main/handlers/chats.test.ts` | Committee then extras without duplicates, an unknown `committeeId` leaving no chat behind, two executors spread across the committee and the extras, the snapshot assertion (editing the committee does not touch the topic), the bootstrap fallback on an empty committee and an empty library, and `chats.update` ignoring a hand-written `committeeId` |
| `src/main/db/postgres/schema-drift.test.ts` | The two new tables and the new column are declared identically in both dialects |
| `src/main/db/migrations.test.ts` | `committees` and `committee_members` are created when the database is opened |
| `src/shared/contracts.test.ts` | The five methods are in `BACKEND_METHODS`, and `committees` is a namespace |
| `src/renderer/src/stores/committees.test.ts` | **S9.2**, against a fake `BackendClient`: load and a failed load; `validateDraft` (blank, whitespace-only and over-cap names, measured trimmed); create from an empty draft, which trims the name and leaves the editor on the row it produced; an invalid draft calling nothing; add / move / remove writing one `committees.update` with the whole list in order; `dirty` going back to false when an edit is undone, the member list included; a `second_executor` refusal kept as `errorCode` + `errorDetails` with the list untouched; delete closing the editor only when it was the open record |
| `src/renderer/src/stores/ui.test.ts` | **S9.2**: `PAGES` is `['chats', 'committees', 'agents', 'settings']` — rail order, Settings last. **S9.3**: the dialog starts closed, opens with and without a committee, forgets the committee on close, and navigates to nothing on its own |
| `src/renderer/src/lib/committee-members.test.ts` | **S9.3**: `mergeMembers` (committee first, first occurrence wins, duplicates within each list, either list alone, neither, and no mutation of its arguments) and `missingCommitteeMembers` (the gap in committee order, nothing when the chat has everyone, ignoring members the committee does not have, and an empty answer for a chat with no committee) |
| `src/renderer/src/stores/chats.test.ts` | **S9.3**: the widened `create` — a title trimmed, a committee and extras sent as three fields; `create({})` and a draft of only blanks both sending `{ input: {} }`, which is the "+" button's call unchanged |
| `src/renderer/src/lib/theme.test.ts` | **S9.3**: `--color-overlay` joins `--color-bg-subtle` as a token with an alpha channel, so the palette, the light override and `prefers-reduced-transparency` are all held to a two-entry list rather than a one-entry one |
| `src/renderer/src/i18n/locales.test.ts` / `used-keys.test.ts` | **S9.2**: `committees` is an expected namespace, the two trees match, and every `t('committees.…')` resolves |
| `e2e/committees.spec.ts` | **S9.2**, offline: the page starts empty and Save is disabled until the name is filled; two agents added through the picker and counted on the list row; a drag reordering them, saved, and still in that order after the app is relaunched; the move-up / move-down buttons doing the same thing without a pointer; a removal; deleting an *agent* removing it from the committee; the two-step delete. **S9.3** inserts two: "New topic" arriving with the committee preselected and the committee's member locked, one extra ticked, the count going 1 → 2, and the created chat listing committee-then-extra with the badge in both places; then an agent added to the committee, the `data-missing` count on the sync button, and the append |
| `src/main/mcp-endpoint/tools.test.ts`, `contract.test.ts` | **S10.5** (owned by [`../mcp-endpoint/`](../mcp-endpoint/implement.md)): `list_committees` over `committees.list`, and `start_discussion({ committee })` resolving by name, by case and by id, appending extras, refusing an unknown, an ambiguous and an empty committee, and convening one that contains an executor. They assert the endpoint's side; `chats.test.ts` above stays the authority on the merge |
| `e2e/ui-shell.spec.ts` | **S9.3**: the `Dialog` primitive itself — `role`, `aria-modal`, focus inside the panel on open, Escape and a backdrop press dismissing it, and a review screenshot in each appearance |
| Every other `e2e/*.spec.ts` | **S9.3**: fourteen files had `chats-new` clicked into them; they all go through `createChat(page)` in `e2e/helpers.ts` now, which is the dialog opened and Create pressed with nothing chosen |

## Known limitations and TODOs

- **Drift is real and deliberate.** A topic convened yesterday does not gain a
  member added to the committee today. S9.3 surfaces it as "Sync committee
  members", which only adds; there is no automatic reconciliation and there
  will not be one.
- **The Postgres migration has not been executed here** — no Docker on the
  machine S9.1 was written on, so `0002_committees.sql` is checked by reading
  and by `schema-drift.test.ts`, like `0001_permission_grants.sql` before it.
- **The merge rule exists twice.** `initialMembers` in the handler is the
  authority; `mergeMembers` in the renderer is a copy that only counts and
  ticks. They are held to the same examples in two test files, which is the
  cheapest guard available — there is no way to share one function across the
  process boundary without putting chat-creation logic in `src/shared`.
- **`committees.get` still has no caller.** The Committees page holds the list
  it edits, the chats page reads `committees.list` for names, and S10.5's
  `list_committees` and `start_discussion` read the list too (they need the
  candidates for a refusal anyway); the method exists for the server host.
- **The dialog does not offer to *create* anything it is missing.** An empty
  agent library or an empty committee list is a sentence pointing at the page
  that fixes it, not a link — the dialog would have to be dismissed to follow
  one, and dismissing it is already one Escape away.
- **The chat's committee cannot be changed after creation**, by design
  (`chats.update` omits `committeeId`). A topic convened on the wrong committee
  is recreated, not re-pointed.
- **The committee list is one reload behind its own ordering.** `committees.list`
  is `updatedAt desc` and a save does not re-sort the row it updated; see
  [`frontend.md`](./frontend.md) for why a row that jumped under the cursor
  would be the worse of the two.
- **A committee is now reachable from an IDE, but not as `@committee`.** S10.5
  built the tools half — `list_committees` and `start_discussion`'s `committee`
  — and **deferred** the generated Claude Code subagent per committee
  (`~/.claude/agents/witena-<slug>.md`), because the assumption it rests on,
  that a subagent restricted to `mcp__witena__*` can be `@`-mentioned and reach
  those tools, has never been run: the `claude` CLI on the machine WP-0b and
  WP-14 ran on is not logged in. Nothing was written under `~/.claude/`. Owned
  by [`../mcp-endpoint/`](../mcp-endpoint/implement.md); carried in S10.7's
  backlog.
