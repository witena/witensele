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
- **S9.3 (done)** — the New chat dialog: the chat list's "+" and the
  Committees page's **New topic** both open it, a topic is convened from a
  committee, individual agents, or both, the committee shows as a badge on the
  chat row and in the chat header, and the member panel offers **Sync committee
  members** when the committee has moved on.

Phase 10 then made committees reachable from outside the app, without adding
anything here:

- **S10.5 (2026-09-20, WP-14)** — the MCP endpoint's `list_committees` tool and
  `start_discussion`'s `committee` argument, so an IDE agent convenes a topic
  from a saved committee. It calls `committees.list` and passes `committeeId` to
  `chats.create`; **no committee API was added or changed**, and the expansion
  stays the one in `initialMembers()`. See
  [`../mcp-endpoint/backend.md`](../mcp-endpoint/backend.md), "Committees
  through the endpoint".

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
| Convening a committee from an IDE, and the wording an agent reads while doing it | [`mcp-endpoint`](../mcp-endpoint/context.md) (S10.5) — it only *calls* `committees.list` and `chats.create` |
| Automatic reconciliation of a topic with its committee | Nowhere. Drift is the price of the snapshot and "Sync committee members" is the whole answer: explicit, append-only, and pressed by the user |
| Removing members during a sync | Nowhere, for the same reason — a member the user took out of a chat took themselves out of that chat |

## Dependencies

| Needs | For what |
|---|---|
| [`agents`](../agents/context.md) | Members are agent ids; `agents.delete` cascades a member away |
| [`database`](../database/context.md) | The two tables in both dialects, the migrations and the repository pattern |
| [`chats`](../chats/context.md) | `chats.create` expands a committee; `Chat.committeeId` is the provenance |
| [`backend-client`](../backend-client/context.md) | The five methods on `BackendApi` and in `BACKEND_METHODS` |
| [`ui-shell`](../ui-shell/context.md) | S9.2's rail button, the `Page` union and the primitives the page is built from |
| [`i18n`](../i18n/context.md) | S9.2's `nav.committees` and the `committees.*` namespace |

Depending on this feature in return: [`chats`](../chats/context.md), for the
New chat dialog, the provenance badge and the sync button — all three read
`Committee` and none of them is reachable while a chat runs. Orchestration
never will. Since S10.5, [`mcp-endpoint`](../mcp-endpoint/context.md) does too:
`list_committees` reads `committees.list`, and `start_discussion` passes a
committee id to `chats.create` exactly as the New chat dialog does.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| Joining is a **snapshot** into `chat_members` | Resolve the committee's members at every round | Orchestration, `@` resolution and the member panel all read one list and keep working unchanged; and an old topic does not silently change its participants because somebody edited the group this morning. The cost is drift, which S9.3 answers with an explicit "Sync committee members" that only adds |
| Membership rides on the entity (`Committee.memberAgentIds`) | A `committees.members.*` pair mirroring `chats.members.*` | A committee is small and is always edited as a whole; one method means the row and its join rows are written in one transaction and a caller cannot leave a committee half-edited. `chats.members.set` exists because a chat's membership changes *during* a conversation, which is not true here |
| `chats.committee_id` is `ON DELETE SET NULL` | `CASCADE`, or no foreign key at all | A topic outlives its committee: the members are already snapshotted and the transcript is the user's. `SET NULL` erases exactly the one thing that stopped being true |
| `chats.update` does not accept `committeeId` | Allow re-pointing a topic at another committee | Provenance is a fact about how the chat was born. A topic that changed committee would be a snapshot of a group it never contained |
| The one-executor rule applies to a committee too | Check only when a chat is convened | A group whose members cannot legally sit in one chat is a group that refuses to convene, and the refusal would arrive when the user opens a topic rather than when they build the group. The **same** `assertOneExecutor` is exported from `handlers/chats.ts`, so the rule and its `second_executor` reason cannot drift |
| A committee name is a label, not an identity | Reject duplicates case-insensitively, as agent names are | Nothing resolves `@Review`; two committees may reasonably be called "Review" while holding different people. Only the trimmed-non-empty and length rules apply |
| **S9.3**: a modal for New chat, where everything else in the app is in place | Keep creating on "+" and choose members afterwards in the panel | Convening is one decision made of three parts (a title, a committee, a set of agents) that only make sense written together. The in-place patterns the app prefers — two-step Delete, the rename row, the member popover — each edit one field of a record that already exists; there is no record here yet. Pressing Create with nothing chosen is still exactly the old "+" |
| **S9.3**: the dialog's open state is in `stores/ui` | Local state in `ChatsPage`, with a prop from the Committees page | "New topic" has to navigate *and* preselect, and the component that pressed it is unmounted before the dialog renders. One boolean in the store is the whole mechanism |
| **S9.3**: sync **appends** | Reconcile (add and remove), or offer a diff to approve | The committee is not an authority over a chat that has already started — it is where the chat came from. Appending is the only operation that cannot destroy a decision the user made inside the conversation |
| **S10.5**: the MCP endpoint convenes a committee by passing `committeeId` to `chats.create`, and never expands one itself | Giving the endpoint its own expansion; adding a `committees.expand` method for it | One place turns a committee into members, and it is `initialMembers()`. A second would drift, and the chat it produced would carry no `committeeId` — so it would lose the badge and the sync offer and look hand-assembled. `committees.list` already carries `memberAgentIds`, so the endpoint can still refuse an empty committee before it creates anything |
| **S10.5**: a committee that contains an executor is convened from the IDE as built | Refusing it there, as the endpoint refuses an executor named individually | It is the user's own group; a committee they assembled deliberately must not be unusable from an IDE, and filtering a member out would be the endpoint editing that group behind their back. What the endpoint holds to is that it starts no hand-off, and it says so in the result. Phase 9's one-executor rule still decides what may be in the room |

## Open questions

- **Does a committee want to own a chat's settings, or only its people?** A
  committee today contributes members and nothing else — the topic it convenes
  gets `DEFAULT_CHAT_SETTINGS` like any other chat, so a group assembled for
  long design arguments still starts at three automatic rounds. "Committee
  default chat settings" is on the Phase 6 backlog as a capability; what is
  genuinely undecided is whether those defaults should be *copied* at creation
  (a snapshot, like the members) or *read* from the committee at run time (an
  authority, unlike the members). Copying is consistent; reading is what a user
  editing a committee would probably expect. Neither answer is owed before the
  backlog entry is picked up.

The backlog entries in "Out of scope" are deferrals, not questions.
