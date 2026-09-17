# database — Frontend

## Pages and components

**None, by design.** The renderer never touches the database. It has no SQLite
driver, no drizzle import, no file path and no table name; `src/main/db/` is
main-process code that the bundler never puts into the renderer chunk.

Everything stored here reaches the UI through the `BackendClient` abstraction —
see [`../backend-client/frontend.md`](../backend-client/frontend.md) for the
client, the stores and the event handling. A component that wants a chat calls a
store action, the store calls `invoke('chats.list')`, and an IPC handler calls
`repositories.chats.list()`. The renderer sees only the shared types.

This is CLAUDE.md rules #5 and #6 working together: because the renderer depends
on one interface rather than on storage, the same pages run unchanged against a
server that keeps its rows in Postgres.

The one thing the renderer has to know about a JSON column is how to **clear** a
field in it: `chats.update` takes `settings.closingAgentId: null` to go back to
"first in speaking order" (S5.16). That is a contract of the shared types
(`ChatSettingsPatch`), not of the storage — the renderer sends `null`, the
repository stores an absent field — and it is the only field in the product with
that shape.

**S8.1 is the first half of testing that claim.** The Postgres dialect now exists
(`src/main/db/postgres/`) and a Node host serves the same `BackendApi` over HTTP
(`../server/`), and neither added, removed or changed one renderer file. The
second half — pointing the renderer at that host — is S8.3.

| File | Responsibility |
|---|---|
| — | This feature owns no renderer file |

## State

None. The stores listed in `../backend-client/frontend.md` mirror
backend-owned data (`chats`, `messages`, `agents`, `providers`, `settings`, and
since S5.15 the permission grants), but they are populated by `BackendClient`
calls and events, never by a query. S5.15's `permission_grants` is the newest
illustration: the renderer draws a list of grants and has no idea that there is
a table behind it — it calls `permissions.grants.list` and renders what comes
back.

| Store | Field | Type | Meaning |
|---|---|---|---|
| — | — | — | — |

## Backend calls

None of its own. The `BackendClient` methods that end up in a repository are
listed in `implement.md` and belong to the features that own them: `providers.*`,
`agents.*`, `mcp.*`, `chats.*`, `messages.list`, `chat.send`, `settings.*`, and
since S5.15 `permissions.grants.*` ([`executor`](../executor/frontend.md)).

| Call / subscription | Called from | Purpose |
|---|---|---|
| — | — | — |

## Interaction states

Two storage behaviours are visible in the UI and worth knowing when building
those screens:

| Behaviour | What the user sees |
|---|---|
| The chat list is ordered by `updatedAt`, which a new message bumps | A chat jumps to the top of the left column as soon as anyone speaks in it |
| Messages are ordered by `seq`, not by their timestamp | In parallel speaking mode the transcript order is stable and identical on every reload, even for replies persisted in the same millisecond |
| `messages.list` pages with `before` as an exclusive cursor | Scrolling up loads older pages with no repeated and no skipped message |
| An API key is stored encrypted and never returned | The provider form shows a "key is set" state rather than a masked value, and re-saving without touching the field keeps the existing key |
| A key encrypted by a **previous installation** cannot be read (S7.6) | The card and the editor say so in one sentence and the key field takes the focus. The row is never overwritten — only pasting a new key replaces it — and the state disappears the moment one is saved. Rows written since S7.6 do not reach this state: their key lives in `userData/secrets.key`, which an update leaves alone |
| A provider row can store **no credential at all** (`auth = 'oauth'`, S5.3) | The card says "signed in" instead of "no key", and the editor shows the sign-in panel where the key field was. There is nothing to encrypt: the Anthropic CLI owns the token and this layer never sees one |
| `chats.goal` is replaced whole, never merged (S5.10) | Removing the last material in the Goal block really removes it. A merged column could not: there is no JSON patch that says "this list is now empty" and also leaves every other field alone |
| Whether a goal's deliverable **exists** is not stored at all (S5.10) | The header chip reads "delivered" from a query (`chats.goalStatus`) run when the chat is opened and whenever it changes — so a file created outside the app is noticed, and a column nobody refreshed can never be wrong |
| Which dialect the rows are in (S8.1) | Nothing. The desktop app is SQLite and will stay so; Postgres is the hosted version's storage, and the shared types the renderer receives are identical either way. If that ever stops being true it is a bug in the schema drift test, not a feature |

## Copy and i18n

No user-facing copy, with one exception to keep in mind: a new chat is stored
with the English title `New chat` (`DEFAULT_CHAT_TITLE`). It is stored content,
not an i18n key, so it is not translated on display — see the open question in
`context.md`. Backend-authored *messages* are unaffected: a `system-notice` part
carries an i18n key and parameters, and the renderer translates it (S1.4).
