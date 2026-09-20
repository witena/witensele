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
  the committee afterwards — that is what makes joining a snapshot.

Orchestration, `AgentTurn` and the supervisor are untouched: they read
`chat_members`, which now simply has members in it sooner.

## Data flow

Convening a topic (the path S9.3 will drive from the New chat dialog):

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

Deleting a committee:

```
committees.delete({ id })
  → repos.chats.listChatIdsForCommittee(id)   ← read *before* the delete
  → DELETE committees            → committee_members cascade,
                                    chats.committee_id → NULL
  → one chat.updated per affected topic
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

## Known limitations and TODOs

- **Drift is real and deliberate.** A topic convened yesterday does not gain a
  member added to the committee today. S9.3 surfaces it as "Sync committee
  members", which only adds; there is no automatic reconciliation and there
  will not be one.
- **The Postgres migration has not been executed here** — no Docker on the
  machine S9.1 was written on, so `0002_committees.sql` is checked by reading
  and by `schema-drift.test.ts`, like `0001_permission_grants.sql` before it.
- **No renderer.** `committees.*` has no caller until S9.2; `Chat.committeeId`
  is carried through the stores and rendered nowhere until S9.3.
