# committees — Backend

Everything here is S9.1. **S9.2 added no backend code at all**: the Committees
page is built entirely on the five methods below, and the one thing it might
have wanted — an event when a committee changes — is deliberately still absent
(see "Events emitted").

## Modules

| File | Responsibility |
|---|---|
| `src/main/db/schema.ts` | `committees`, `committeeMembers` and `chats.committeeId`, plus `CommitteeRow` / `CommitteeMemberRow` |
| `src/main/db/postgres/schema.ts` | The same three declarations in `drizzle-orm/pg-core` |
| `src/main/db/migrations/0005_ambiguous_sersi.sql` | SQLite: the two tables and the new column |
| `src/main/db/postgres/migrations/0002_committees.sql` | Postgres: the same, hand-written |
| `src/main/db/repositories/committees.ts` | `createCommitteeRepository`: list / get / create / update / delete, membership read and replaced in the committee's own transaction |
| `src/main/db/repositories/chats.ts` | `committeeId` on the mapped `Chat` and on create; `listChatIdsForCommittee`; `ChatCreateFields` |
| `src/main/db/repositories/index.ts` | `Repositories.committees` |
| `src/main/handlers/committees.ts` | `committees.*`: validation, and the `chat.updated` fan-out on delete |
| `src/main/handlers/chats.ts` | `chats.create` expands the committee; `assertOneExecutor` is exported for `committees.*` to reuse |
| `src/main/handlers/index.ts` | `committeeHandlers` in `MODULES` |

Neither file imports electron (CLAUDE.md rule #5): the repository takes a
`DrizzleDb`, the handlers take an `AppContext`, and `src/server` mounts them
with no change of its own.

## Database

### `committees`

| Column | Type | Notes |
|---|---|---|
| `id` / `user_id` / `created_at` / `updated_at` | | As every entity table |
| `name` | text not null | Trimmed, non-empty, at most `MAX_COMMITTEE_NAME_CHARS` (100). Not unique — a name is a label here, not an identity |
| `description` | text not null default `''` | |

### `committee_members`

| Column | Type | Notes |
|---|---|---|
| `committee_id` | text not null | FK → `committees.id`, `ON DELETE CASCADE` |
| `agent_id` | text not null | FK → `agents.id`, `ON DELETE CASCADE` |
| `position` | integer not null | Speaking order, 0-based, the index in `memberAgentIds` |

Composite primary key `(committee_id, agent_id)`. No `id`, no `user_id`, no
timestamps: a pure join table, shaped exactly like `chat_members` and scoped
through the committee. The agent cascade leaves a **gap** in the positions
(0, 2, 3); members are always read `ORDER BY position` into an array, so the gap
disappears on read and the next write renumbers from 0. Nothing renumbers rows
in place, because nothing has to.

### `chats.committee_id`

| Column | Type | Notes |
|---|---|---|
| `committee_id` | text null | FK → `committees.id`, **`ON DELETE SET NULL`**. Provenance, not membership: the committee's members were snapshotted into `chat_members` at creation. Null means "not convened from a committee", which is what every row written before S9.1 holds |

Migrations:

| File | Step | What it changes |
|---|---|---|
| `0005_ambiguous_sersi.sql` | S9.1 | `CREATE TABLE committees`, `CREATE TABLE committee_members`, `ALTER TABLE chats ADD committee_id`. **Hand-edited after `npm run db:generate`**: drizzle-kit emitted the new column's `REFERENCES` clause without the `ON DELETE set null` that its own `meta/0005_snapshot.json` records, and without the action a committee delete would be *refused* by the foreign key instead of clearing the column. The two `CREATE TABLE`s were also swapped so `committees` precedes the table that references it. The file's header comment says so |
| `postgres/migrations/0002_committees.sql` | S9.1 | The same three changes as Postgres DDL, hand-written like `0001_permission_grants.sql`. The column is added and the constraint attached in two statements so the file is re-runnable |

## IPC handlers

| Channel | Input | Output | Errors |
|---|---|---|---|
| `committees.list` | — | `Committee[]` | — |
| `committees.get` | `{ id }` | `Committee` | `validation` for a missing id; `not_found` for an unknown one |
| `committees.create` | `{ input: CommitteeInput }` | `Committee` | `validation` for a non-object input, a blank name, a name past the cap, a non-string description, a `memberAgentIds` that is not an array of ids, a duplicate member, or two executors (`details.reason = 'second_executor'`); `not_found` for a member that names no agent of this user. All of it before anything is written |
| `committees.update` | `{ id, patch: CommitteePatch }` | `Committee` | `not_found` first, so a patch for a deleted committee does not fail as bad input; then the same field rules, applied only to the fields the patch carries |
| `committees.delete` | `{ id }` | `void` | `not_found` for an unknown id |
| `chats.create` | `{ input: ChatCreateInput }` | `Chat` | Additionally: `validation` for a `committeeId` that is not a non-empty string, `not_found` for one that names no committee, and the existing `second_executor` refusal now measured over the **merged** list, before the row exists |

The merge rule, in one sentence: the committee's members in `position` order,
then `memberAgentIds`, de-duplicated keeping the **first** occurrence — so an
agent who is both keeps the committee's place in the speaking order. The
bootstrap-agent fallback is unchanged and fires only when the merged list is
empty *and* the agent library is empty.

`chats.update` does not accept `committeeId`: `ChatPatch` omits the field and
the repository never writes it outside `create`, so a hand-written patch is
ignored rather than obeyed.

## Events emitted

| Event | Payload | Emitted when |
|---|---|---|
| `chat.updated` | `{ chat }` | `committees.delete`, once per topic whose `committeeId` has just become null. The ids are read **before** the delete — afterwards the foreign key has already cleared the column and there is nothing left to join on |

`chats.create` emits its usual `chat.updated`. There is no `committee.*` event:
the only committee change the rest of the app can observe is a chat's
provenance.

## Filesystem

Nothing. Committees live entirely in the database.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| drizzle-orm | Both schemas, the queries and `db.transaction` | `inArray` with an empty array is invalid SQL, so `list` returns early when there are no committees to fetch members for |
| drizzle-kit (`npm run db:generate`) | The SQLite migration | It drops `ON DELETE` from a `REFERENCES` clause on `ALTER TABLE … ADD COLUMN`, and orders new `CREATE TABLE`s alphabetically. Read the generated file before committing it; this one was edited, and the edit is documented in its header |
| better-sqlite3 | The SQLite side | `ON DELETE SET NULL` only fires with `PRAGMA foreign_keys = ON`, which `openDatabase` sets. A column added by `ALTER TABLE` may carry a `REFERENCES` clause only because its default is NULL — which it is |
