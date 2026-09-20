# committees — Context

## Problem

The same people are asked the same kind of question again and again: an
architecture review needs the systems thinker, the sceptic and the person who
writes the code, and assembling those three by hand every time a question comes
up is work the user should only do once. A **committee** is that group, saved
under a name and in an order. A chat is then a *topic* the committee is convened
on, and the user starts one by picking the committee rather than by picking
people.

A committee only assembles people. It never holds a conversation itself, has no
transcript, and nothing in it is read while a chat runs.

## Scope

Phase 9, in three steps:

- **S9.1 (done)** — committees exist in the backend: the two tables, the
  `Committee` type, the five `committees.*` methods, and `chats.create`
  expanding a committee's members into a new chat.
- **S9.2 (done)** — the Committees page: a fourth rail destination where a
  committee is named and described, its members are added, reordered and
  removed, and the topics it has been convened on are listed. The member picker
  and the drag-to-reorder list are extracted from the chat's member panel so
  both screens behave identically.
- **S9.3** — the New chat dialog, the committee badge on a topic, and "Sync
  committee members" in the member panel.

Settled before the phase started, and true of all three steps:

- **Joining is a snapshot.** A committee's members are expanded into
  `chat_members` when the chat is created, and `chats.committee_id` records
  where they came from. Nothing reads the committee again.
- **A chat belongs to at most one committee**, plus any number of individual
  agents.
- **The identifier is `committee` everywhere** — `group` already means "Group
  settings" and `panel` already means a side panel.

## Out of scope

| Not here | Where it belongs |
|---|---|
| A committee charter in the system prompt | Phase 6 backlog; [`agent-turn`](../agent-turn/context.md) owns the prompt |
| Committee-level default chat settings | Phase 6 backlog |
| Several committees in one chat | Phase 6 backlog; the column is single-valued on purpose |
| Grouping or filtering the chat list by committee | Phase 6 backlog; [`chats`](../chats/context.md) |
| Anything a running chat does with its members | [`orchestration`](../orchestration/context.md) — it keeps reading `chat_members` and does not know committees exist |
| The New chat dialog, "New topic", the committee badge, "Sync committee members" | S9.3. S9.2's page builds a committee; it cannot yet start a conversation with one |

## Dependencies

| Needs | For what |
|---|---|
| [`agents`](../agents/context.md) | Members are agent ids; `agents.delete` cascades a member away |
| [`database`](../database/context.md) | The two tables in both dialects, the migrations and the repository pattern |
| [`chats`](../chats/context.md) | `chats.create` expands a committee; `Chat.committeeId` is the provenance |
| [`backend-client`](../backend-client/context.md) | The five methods on `BackendApi` and in `BACKEND_METHODS` |
| [`ui-shell`](../ui-shell/context.md) | S9.2's rail button, the `Page` union and the primitives the page is built from |
| [`i18n`](../i18n/context.md) | S9.2's `nav.committees` and the `committees.*` namespace |

Depending on this feature in return: nothing yet. S9.3 adds the New chat dialog;
orchestration never will.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| Joining is a **snapshot** into `chat_members` | Resolve the committee's members at every round | Orchestration, `@` resolution and the member panel all read one list and keep working unchanged; and an old topic does not silently change its participants because somebody edited the group this morning. The cost is drift, which S9.3 answers with an explicit "Sync committee members" that only adds |
| Membership rides on the entity (`Committee.memberAgentIds`) | A `committees.members.*` pair mirroring `chats.members.*` | A committee is small and is always edited as a whole; one method means the row and its join rows are written in one transaction and a caller cannot leave a committee half-edited. `chats.members.set` exists because a chat's membership changes *during* a conversation, which is not true here |
| `chats.committee_id` is `ON DELETE SET NULL` | `CASCADE`, or no foreign key at all | A topic outlives its committee: the members are already snapshotted and the transcript is the user's. `SET NULL` erases exactly the one thing that stopped being true |
| `chats.update` does not accept `committeeId` | Allow re-pointing a topic at another committee | Provenance is a fact about how the chat was born. A topic that changed committee would be a snapshot of a group it never contained |
| The one-executor rule applies to a committee too | Check only when a chat is convened | A group whose members cannot legally sit in one chat is a group that refuses to convene, and the refusal would arrive when the user opens a topic rather than when they build the group. The **same** `assertOneExecutor` is exported from `handlers/chats.ts`, so the rule and its `second_executor` reason cannot drift |
| A committee name is a label, not an identity | Reject duplicates case-insensitively, as agent names are | Nothing resolves `@Review`; two committees may reasonably be called "Review" while holding different people. Only the trimmed-non-empty and length rules apply |

## Open questions

None. The three backlog entries above are deferrals, not questions.
