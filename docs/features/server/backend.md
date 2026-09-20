# server — Backend

## Modules

Nothing under `src/server/` imports electron, and `no-electron.test.ts` proves it
for the whole transitive closure rather than for these six files alone.

| File | Responsibility |
|---|---|
| `src/server/index.ts` | The process entry. `startServer(config)`, `SIGINT` / `SIGTERM`, `process.exit`. The sibling of `src/main/index.ts` |
| `src/server/config.ts` | The only reader of `process.env`. `readConfig(env)` → `ServerConfig` |
| `src/server/context.ts` | `createServerContext(config)`: the data directory, `FileKeySecretStore`, `createAppContext`, `migrateProviderSecrets` |
| `src/server/http.ts` | `createWitenaServer({ ctx, handlers })`: the routes, the error-to-status table, the body cap, the WebSocket fan-out |
| `src/server/user.ts` | `resolveUserId(request)`. The S8.2 seam |
| `vite.server.config.ts` | The build. External dependencies, `out/server/index.js`, ESM |

Reused unchanged, and the point of the step:

| File | What the server takes from it |
|---|---|
| `src/main/app-context.ts` | `createAppContext` — the same context the desktop builds |
| `src/main/handlers/index.ts` | `buildHandlers()` — the same total map |
| `src/main/ipc-protocol.ts` | `toBackendError`, `InvokeResponse`. Named for IPC, imports no electron, and is the shared wire format |
| `src/main/secrets.ts` | `createFileKeySecretStore` |
| `src/main/providers/migrate-secrets.ts` | The startup re-encryption pass |
| `src/main/errors.ts` | `BackendFailure` |

The Postgres dialect, which belongs to [`../database/`](../database/backend.md)
and is listed there too:

| File | Responsibility |
|---|---|
| `src/main/db/postgres/schema.ts` | The seven tables in `drizzle-orm/pg-core` |
| `src/main/db/postgres/migrations/0000_init.sql` | The current shape as Postgres DDL |
| `src/main/db/postgres/database.ts` | `openPostgresDatabase`, `runPostgresMigrations`, `truncateAll` |
| `src/main/db/dialects.ts` | `describeDialects` and the row gateway both dialects answer |

## Database

S8.1 adds **no table and no column**. It adds a second dialect of the seven that
exist, so the table below is about how each type is spelled rather than about new
storage.

| Table | Column | Type | Notes |
|---|---|---|---|
| all seven | `created_at`, `updated_at` | SQLite `integer` / Postgres `bigint` | Epoch milliseconds. Postgres `integer` is four bytes and cannot hold one; this is the difference that makes neutral SQL impossible |
| `agents` | `memory_enabled` | SQLite `integer` (`{ mode: 'boolean' }`) / Postgres `boolean` | Same for `mcp_servers.enabled` and `side_effects` |
| `providers` | `models` | SQLite `text` (`{ mode: 'json' }`) / Postgres `jsonb` | Same for every JSON column: `avatar`, `params`, `skill_names`, `mcp_server_ids`, `args`, `env`, `goal`, `settings`, `parts`, `mentions`, `in_reply_to`, `usage`, `data` |
| `messages` | `seq`, `round` | `integer` in both | Counters, not timestamps: four bytes is two billion messages in one chat |
| `chat_members`, `messages` | `chat_id`, `agent_id` | `text` with `ON DELETE cascade` in both | The cascades are asserted against both dialects by `dialects.test.ts` |
| `__migrations` | `name`, `applied_at` | `text` / `integer`–`bigint` | The bookkeeping table, created by each migrator on first run |

Migrations: `src/main/db/postgres/migrations/0000_init.sql` — creates all seven
tables and the two `messages` indexes in the shape `schema.ts` describes today.
It starts at `0000` rather than replaying the four SQLite files because no
Postgres database predates it. The SQLite history
(`0000_outstanding_medusa` … `0003_acoustic_vermin`) is untouched.

## IPC handlers

**None added.** The server mounts the existing map; it does not extend it.

| Channel | Input | Output | Errors |
|---|---|---|---|
| `POST /api/<method>` | The method's single argument as a JSON body; empty body = `undefined` | `{ ok: true, value }`, 200 | `{ ok: false, error }` with the status from `ERROR_STATUS`. A name outside `BACKEND_METHODS` is 404 `not_found`; a non-`POST` is 400 `validation` with `Allow: POST`; a body over 8 MB or not valid JSON is 400 `validation`; anything a handler throws becomes `internal` unless it was a `BackendFailure` |
| `GET /ws` | WebSocket handshake | One `BackendEvent` JSON frame per event | An upgrade on any other path gets a raw `404`; a user that is not the context's own gets a raw `401` |
| `GET /healthz` | — | `{ "status": "ok" }`, 200 | None. It reads nothing |

The five methods that need a window (`system.pickFolder`, `system.pickSavePath`,
`system.pickPaths`, `system.applyTheme`, and `system.openInEditor` for the
`vscode://` and `cursor://` schemes) are mounted like every other method and
answer with the `internal` rejection `src/main/handlers/system.ts` already gives
them, naming the `src/main/ipc/` file that would implement them. `openInEditor`
with `editor.kind === 'custom'` genuinely works on this host, because that branch
is `node:child_process` rather than `shell.openExternal`.

**The MCP endpoint is not mounted here** (S10.3): `createServerContext` passes no
`mcpEndpoint` option, so `ctx.mcpEndpoint` is `null`, nothing listens on `/mcp`,
no discovery file is written, and `settings.update`'s live toggle is a no-op —
the row is stored, the door does not exist. The tools are transport-agnostic, so
`createMcpEndpoint({ ctx, handlers, token })` can be routed from
`src/server/http.ts` once accounts exist; what is desktop-only is the *host*, and
deliberately so — a loopback socket plus a `0600` file in `userData` is how a
shim on the same machine finds the app, and neither means anything to a remote
client (PLAN.md, "Online version"; backlog).

## Events emitted

| Event | Payload | Emitted when |
|---|---|---|
| — | — | The server emits none of its own. It **forwards** every `BackendEvent` the bus carries, unchanged, as one JSON frame per event per open socket |

The forwarding is one subscription for the whole process: the event is
serialised once and written to each socket, so N clients cost N writes rather
than N serialisations, and every client receives an identical frame.

## Filesystem

Everything lives under `WITENA_DATA_DIR` (default `./.witena-data`, gitignored),
which is the server's `app.getPath('userData')`:

```
<dataDir>/
  witena.db          the SQLite database, WAL files beside it
  secrets.key        the FileKeySecretStore key, 0600, path overridable with
                     WITENA_SECRETS_KEY
  skills/            per-agent skill library, read by the skills feature
  memory/            per-agent markdown memory
```

The directory is created at startup; nothing else in it is. Unlike the desktop
app, the server does **not** seed `skills/` from `resources/` — the bundled
skills are copied by the packaged application on first launch, and a server that
wants them can have them mounted. S8.3 decides whether the hosted product ships a
library of its own.

Cleanup is the operator's: nothing prunes the database, the WAL or the memory
folders, exactly as on the desktop.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `ws` | The WebSocket server, in `noServer: true` mode so `node:http`'s own `upgrade` event decides which paths are upgradable | `handleUpgrade` must be called from the `upgrade` listener and the socket destroyed by hand on every path that is refused, or a client hangs waiting for a handshake that will never come. `socket.readyState` has to be checked before `send` rather than caught: a send to a closing socket throws inside whatever called it, which here is the event bus's delivery loop |
| `pg` | The Postgres driver behind drizzle's `node-postgres` dialect | It is CommonJS, so the import is `import pg from 'pg'` and the pool is `new pg.Pool(…)`; a named import of `Pool` does not survive the ESM build. `pool.end()` must be awaited on shutdown or a redeploy leaves connections open until the server's own timeout. `int8` comes back as a **string** by default — drizzle's `bigint(…, { mode: 'number' })` is what converts it, which is why the timestamp columns are declared that way and why `dialects.test.ts` asserts `typeof createdAt === 'number'` |
| `drizzle-orm/pg-core`, `drizzle-orm/node-postgres` | The Postgres schema and handle | The query builders are promises with no synchronous escape, which is the whole reason the repositories cannot yet run on Postgres (see [context.md](./context.md)). `getTableColumns` and `getTableName` are dialect-agnostic and are what the drift test and the row gateway are built on |
| `node:http` | The server itself | `server.close()` alone waits for keep-alive connections to drain, so `closeAllConnections()` is called beside it or a test's `afterEach` hangs for seconds. `request.url` is a path, not a URL, so it is parsed against a dummy origin |
| `vite` (build only) | Resolving `import.meta.glob` and `@shared/*` for the server bundle | `ssr: true` plus an explicit `external` list; without the list rollup tries to bundle `better-sqlite3` and the native binding disappears |
