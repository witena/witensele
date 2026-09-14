# database — Context

## Problem

Everything the user configures and everything the agents say has to survive
closing the app. Providers, agents, MCP servers, chats, who is in them, every
message and the application settings all live in one SQLite file under the
userData directory. This feature is the layer that owns that file: the schema, the
migrations that create and evolve it, and the typed repositories every other
backend feature persists through.

It is **infrastructure**: it has no screen of its own. Its users are the IPC
handlers (S1.3 onwards), `ChatRunner` and `AgentTurn`.

## Scope

- `src/main/db/schema.ts` — the drizzle definition of all seven tables. Columns
  are added by later steps (S2.3's `messages.in_reply_to`, S5.3's
  `providers.auth`), always through a generated migration, never by editing one
  that has shipped.
- `src/main/db/migrations/` — generated SQL plus drizzle-kit's `meta/` snapshot,
  and `drizzle.config.ts` at the repository root that produces them.
- `src/main/db/migrate.ts` — the migrator, which applies the SQL that was
  **inlined into the bundle at build time** rather than read from disk.
- `src/main/db/database.ts` — `openDatabase(filePath)`: pragmas, drizzle wrapper,
  migrations, `close()`.
- `src/main/db/repositories/` — one repository per domain, all returning the
  shared types from `src/shared/types.ts`.
- `src/main/errors.ts` — `BackendFailure`, the `BackendError`-shaped error the
  repositories throw (`not_found`, `validation`).
- The wiring in `src/main/index.ts` that opens the file at
  `app.getPath('userData')/witena.db` and closes it on `before-quit`.

## Out of scope

| Not here | Owned by |
|---|---|
| Encrypting and decrypting API keys | `../providers/`, S1.6 — and S7.6, which changed *which* store produces that ciphertext and added a startup re-encryption pass. The repository is unchanged: it stores what the injected `encrypt` returns and hands it back out, and neither `safeStorage` nor `node:crypto` appears in this layer |
| Exposing any of this to the renderer | `../backend-client/`, S1.3. Repositories are main-process objects; the renderer only ever sees `BackendClient` |
| Business rules (who speaks next, when a message is `passed`) | `../orchestration/`, `../agent-turn/` |
| Skills and memory content | `../skills/`, `../memory/` — both are markdown files on disk, deliberately not rows |
| Runtime input validation (zod) | The IPC handler that owns each method. The repositories check only what storage itself requires: the row exists, belongs to the user, and the member list has no duplicates |
| Backup, export and vacuum | S4.4 and later |

## Dependencies

- `../backend-client/` for every type this layer reads and returns
  (`Provider`, `Agent`, `McpServer`, `Chat`, `ChatMember`, `Message`,
  `AppSettings`, `BackendError`). The schema exists to satisfy those types, not
  the other way round.
- `better-sqlite3` (synchronous driver) and `drizzle-orm` / `drizzle-kit`.

Everything that persists anything depends on this feature: `../providers/`,
`../agents/`, `../chats/`, `../orchestration/`, `../presence/` (indirectly, through
messages) and `../mcp/`.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| A `seq` integer per chat, assigned inside the insert transaction, as the ordering key | Order by `created_at`; order by `created_at, id` | In parallel speaking mode several agents are persisted within the same millisecond, and `ORDER BY created_at` then returns an arbitrary order that can differ between two reads. `seq` gives a total order and makes the paging cursor exact |
| `seq` stays out of the shared `Message` type | Expose it and page by `seq` | The renderer's cursor is already a message id (`messages.list({ before })`); resolving it to a `seq` here keeps the contract unchanged and the ordering key an implementation detail |
| Our own migrator over `import.meta.glob(… '?raw')` | drizzle's `migrate(db, { migrationsFolder })`; embedding SQL as a TypeScript string | The folder-based migrator reads files at runtime, which do not exist next to the packaged `out/main/index.js`. The glob inlines the SQL at build time and is resolved identically by vitest and electron-vite, so tests exercise the real code path. Handwritten strings would drift from the schema |
| Timestamps are integers holding epoch milliseconds | SQLite `datetime` text; unix seconds | The shared types define every timestamp as `number` epoch ms. One representation, converted nowhere |
| JSON columns typed with `$type<…>()` against the shared types | `text` plus a cast at the call site | A change in `shared/types.ts` then breaks compilation here instead of producing a wrong object at runtime |
| Every method takes `userId`, defaulting to `LOCAL_USER_ID` | Filter by user in a layer above; add it when the server arrives | Scoping is the thing that is impossible to retrofit safely. Passing it explicitly means the server version only changes callers, never queries |
| A row belonging to another user is `not_found`, not `unauthorized` | A distinct error code | It reveals nothing about which ids exist. `unauthorized` stays reserved for authentication in the server version |
| Repositories return shared types, never rows | Return rows and map in the IPC layer | `hasApiKey` instead of ciphertext, absent optional fields instead of `null`, and JSON already parsed — done once, in the layer that knows the storage shape |
| `encrypt` is injected | Import `safeStorage` here | CLAUDE.md rule #5: nothing under `src/main/db/` may import electron. It also makes the key paths testable |
| Decryption is *not* in the repository; `getApiKeyCiphertext()` is | Symmetric `encrypt` / `decrypt` injection | Only one caller ever needs plaintext (constructing a model client). Keeping decryption out of storage means a compromised query path cannot return a usable key |
| A chat's goal is **one JSON column**, replaced whole (S5.10) | Four columns (`goal_kind`, `goal_description`, `goal_deliverable`, `goal_materials`); a `goals` table | The four fields are only ever read and written together, and a `deliverable` means nothing without its `kind` — so four columns would be four chances to store a combination no reader can make sense of. It is replaced rather than merged because `materials` is a list the user removes from, and a merge can never delete its last entry |
| Settings are one JSON blob per user | A column per setting; a key/value table | Adding a setting then needs no migration, and reads merge over `DEFAULT_APP_SETTINGS` so an old row is still complete |
| Cascading foreign keys for `chat_members` and `messages` | Delete by hand in the repository | One statement cannot forget a table. It does require `PRAGMA foreign_keys = ON`, which `openDatabase` sets and a test asserts |
| `''` means "clear this column" in patches | A separate `{ clear: [...] }` field; `null` in the patch | `exactOptionalPropertyTypes` and JSON transport both blur absent versus `undefined`, and the `apiKey` contract in `shared/backend.ts` already uses `''` for "clear". The same rule now applies to `baseUrl`, `presetId`, `command`, `url` and `error` |
| A new column is nullable with no default, and the *meaning* of `NULL` lives in the shared types (S5.3's `providers.auth`, S5.10's `chats.goal`) | `NOT NULL DEFAULT 'apiKey'`; a data migration that fills every row | SQLite adds a nullable column in place, so the upgrade is instant and a row written by an older build stays readable. Putting the default in the column as well as in `providerAuth()` would be two statements of the same fact, and the one in SQL cannot be changed later without another migration |
| **S7.6: re-encrypting the stored keys is a startup pass, not a SQL migration** | A `0004_…sql` that rewrites `api_key_encrypted`; a new column for the format | SQL cannot decrypt anything. The work needs the `safeStorage` store *and* the file key in the same process, it can legitimately fail per row, and what it produces for a row it could not read is a fact in memory rather than a value to store. `migrateProviderSecrets` is therefore ordinary code that runs after the context exists, is idempotent, and is skipped row by row on every launch after the first |
| **S7.6: `keyState` is a runtime field on `Provider`, not a column** | `key_state text`; a `secret_format` column | It is a fact about *this installation's* encryption key, not about the row: the same database on the machine that wrote it reads perfectly. A column would be a cached answer that is wrong as soon as anything about the environment changes, and it would need a migration to say something the ciphertext's own prefix already says |

## Open questions

- `DEFAULT_CHAT_TITLE` is the English string `'New chat'` stored in the row. It is
  content rather than UI copy, so it is not an i18n key, but a user running in
  Chinese still sees an English default until S4.3 generates a real title. S1.7
  may instead let the renderer pass a translated title on creation.
- `nextSeq` is computed as `max(seq) + 1` inside the insert transaction. That is
  correct for one process with one SQLite writer, which is exactly the MVP. A
  server with several writers would need the counter in its own row or a
  database-side sequence.
- No pruning or archiving. A very long chat keeps every message forever; context
  truncation (S4.2) only affects what is sent to a model, not what is stored.
