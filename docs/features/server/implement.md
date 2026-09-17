# server — Implementation

## Approach

The server is a **host**, not a layer. `src/main/index.ts` and
`src/server/index.ts` are siblings: each asks its platform where things live,
builds one `AppContext`, builds the handler map, mounts the two channels and
tears the whole thing down on the way out. Everything between the transport and
the database is shared, byte for byte.

| File | Owns |
|---|---|
| `src/server/config.ts` | The only reader of `process.env`. `PORT`, `HOST`, `WITENA_DATA_DIR`, `WITENA_SECRETS_KEY`, `DATABASE_URL` → one `ServerConfig` |
| `src/server/context.ts` | `ServerConfig` → `AppContext`: the data directory, `FileKeySecretStore`, `createAppContext`, the startup secret migration |
| `src/server/http.ts` | The transport: `POST /api/<method>`, `GET /ws`, `GET /healthz`, the error-code-to-status table, the body cap, the bus fan-out |
| `src/server/user.ts` | Who a request belongs to. One function, `LOCAL_USER_ID` today, the JWT in S8.2 |
| `src/server/index.ts` | `startServer(config)`, the signal handlers and the `process.exit` |
| `vite.server.config.ts` | The build behind `npm run server` |

The mount is a loop over `BACKEND_METHODS`, or rather the absence of one: the
route is computed from the path (`/api/` + the method name) and checked with
`isBackendMethod`, exactly as `registerIpc` checks the first IPC argument. There
is no route table to fall out of step with the contract, which is the same
property the Electron transport has and for the same reason.

### Running it

```
npm run server                      # vite build → out/server/index.js → node
PORT=8080 WITENA_DATA_DIR=/srv/data npm run server
curl -s localhost:4317/healthz
curl -s -XPOST localhost:4317/api/system.ping
```

It is a Vite build rather than `node src/server/index.ts` because both migrators
inline their SQL with `import.meta.glob(… '?raw')`, a Vite primitive. Three
toolchains now resolve it — electron-vite for the desktop, vitest for the tests,
`vite.server.config.ts` for the server — so all three hosts run the same
migration code instead of two of them running it and the third approximating it.
Every dependency stays external; `better-sqlite3` in particular has to remain a
runtime `require` of the platform binary.

### Postgres

`src/main/db/postgres/` is the second dialect, shaped like the first:

| File | Owns |
|---|---|
| `schema.ts` | The seven tables in `pg-core`. `bigint` for epoch milliseconds, `boolean`, `jsonb` |
| `migrations/0000_init.sql` | The current shape, split on drizzle's `--> statement-breakpoint` |
| `database.ts` | `openPostgresDatabase(url)`, `runPostgresMigrations(pool)`, `truncateAll(db)` |
| `schema-drift.test.ts` | The two schemas declare the same tables, columns, nullability, defaults and primary keys |

`docker compose up -d postgres` starts the server the fixture connects to.
`DATABASE_URL` is what turns the Postgres half of the suite on. The migrator
takes `pg_advisory_xact_lock` for the whole pass, which SQLite needs no
equivalent of — the first place the two dialects stop being the same problem.

**The repositories still run on SQLite only.** The reason is written out in
[context.md](./context.md), "Postgres is not the server's database yet": the
repository interface is synchronous and drizzle's Postgres driver is not.

## Data flow

One request:

```
HttpBackendClient.invoke('chats.create', input)     (S8.3; curl today)
  → POST /api/chats.create, body = the single argument
  → http.ts: pathname → isBackendMethod → resolveUserId → readBody → JSON.parse
  → handlers['chats.create'](ctx, input)
  → repositories → SQLite
  → { ok: true, value: Chat }                        200
```

The failure path, which is the same code in both transports:

```
handler throws BackendFailure('not_found', …)
  → toBackendError()            (src/main/ipc-protocol.ts, shared with IPC)
  → { ok: false, error }        status = ERROR_STATUS[error.code]
```

One streaming run, which is the whole reason there is a WebSocket:

```
POST /api/chat.send                     → the stored user Message, immediately
  ChatRunner schedules the round
  AgentTurn streams
    ctx.events.emit({ type: 'message.created', … })
    ctx.events.emit({ type: 'message.delta',  … })   × one per token
    ctx.events.emit({ type: 'message.updated', … })
    ctx.events.emit({ type: 'run.finished',   … })
  → one bus subscription, JSON.stringify once
  → socket.send(frame) to every open client of GET /ws
```

Startup and shutdown:

```
readConfig(process.env)
  → mkdir dataDir → FileKeySecretStore(secretsKeyPath) → createAppContext
  → migrateProviderSecrets(ctx)        (the same startup pass the desktop runs)
  → createWitenaServer({ ctx, handlers: buildHandlers() }) → listen
SIGINT | SIGTERM
  → server.close()   every socket closed, listener stopped, connections dropped
  → ctx.close()      runners stopped, supervisor stopped, MCP children killed, db closed
  → exit 0
```

## Key types and contracts

This feature adds no `BackendClient` method and no event. It adds a second
**binding** of the existing ones.

| Route | Request | Response | Notes |
|---|---|---|---|
| `POST /api/<method>` | The method's single argument as a JSON body; an empty body is `undefined` | `{ ok: true, value }` at 200, or `{ ok: false, error }` at the error's status | `<method>` is any entry of `BACKEND_METHODS`. Anything else is 404, a non-`POST` is 400 with `Allow: POST` |
| `GET /ws` | A WebSocket handshake | One JSON `BackendEvent` per frame | One connection per client; the server never reads a frame |
| `GET /healthz` | — | `{ "status": "ok" }` | Touches neither the database nor the context |

| Type | Where | Meaning |
|---|---|---|
| `ServerConfig` | `src/server/config.ts` | Host, port, data directory, database path, key path, optional `DATABASE_URL` |
| `WitenaServer` | `src/server/http.ts` | `{ server, port, origin, clients, listen(), close() }` |
| `ERROR_STATUS` | `src/server/http.ts` | `Record<BackendErrorCode, number>`, total over the union |
| `PostgresHandle` | `src/main/db/postgres/database.ts` | `{ db, pool, close() }`, the asynchronous twin of `DatabaseHandle` |
| `DialectFixture` / `DialectStore` | `src/main/db/dialects.ts` | The dual-dialect test fixture and its row gateway |

`BackendErrorCode` → status, in full:

| Codes | Status |
|---|---|
| `validation` | 400 |
| `unauthorized` | 401 |
| `not_found` | 404 |
| `aborted`, `ant_missing`, `ant_not_logged_in`, `gcloud_missing`, `gcloud_not_logged_in`, `gcloud_no_project`, `key_unreadable` | 409 |
| `provider_error`, `mcp_error` | 502 |
| `internal` | 500 |

## Tests

| File | Covers |
|---|---|
| `src/server/http.test.ts` | A real server on an ephemeral port: `/healthz`; `system.ping` and a no-argument method; a `not_found` serialised into a 404 and the IPC envelope; an unknown method and a `GET` on a method route; the electron-only methods answering with their Electron-free rejection; a body that is not JSON; two WebSocket clients each receiving the same event as one frame; an upgrade on any other path refused; and the whole path — `providers.create`, `agents.create`, `chats.create`, `chat.send` against a `MockLanguageModelV4` — asserting that `message.created`, `message.delta` and `run.finished` arrive over the socket, that the deltas reassemble into the model's own text, and that the transcript agrees with the stream |
| `src/server/no-electron.test.ts` | Starts at every production file under `src/server/`, follows every relative and `@shared` import transitively, and fails on an `electron` specifier anywhere in the closure. Asserts the closure really does reach `app-context.ts`, `chat-runner.ts` and the handler registry, so the claim is not vacuous; and asserts its own scanner recognises all five spellings of an electron import |
| `src/main/db/postgres/schema-drift.test.ts` | The SQLite and Postgres schemas declare the same seven tables, and each table the same columns, nullability, defaults, primary keys and enum values. Needs no database |
| `src/main/db/dialects.test.ts` | The storage contract, run against SQLite always and Postgres when `DATABASE_URL` is set: JSON arrays and objects come back parsed; a boolean is a boolean; an epoch-millisecond timestamp survives (the assertion that `bigint` rather than `integer` is right for Postgres); the settings blob; a chat goal replaced and cleared; ordering by `seq` rather than by insertion; filtering; a chat delete cascading to members and messages but not to agents; an agent delete cascading to memberships only; an update touching one row |

### What CI does not run

`.github/workflows/ci.yml` runs `npm test` on macOS with no `DATABASE_URL`, so
the Postgres half of `dialects.test.ts` is **skipped there**, exactly as it is on
a laptop without Docker. The skip is labelled with the command that would turn it
on rather than hidden. Adding a Postgres service to CI is a one-line
`services:` block and is deliberately left until S8.5, when there is a deployment
whose migrations are worth gating on; until then the Postgres path is verified by
a developer running compose, and "CI proves Postgres works" is not a claim this
repository makes.

`npm run server` is not built in CI either. `npm run build` covers the desktop
bundle; the server bundle is built by `npm run server` itself and, from S8.5, by
the image build.

## Known limitations and TODOs

- **The handlers run on SQLite only.** See [context.md](./context.md), "Postgres
  is not the server's database yet". `DATABASE_URL` is read, honoured by the
  migrator and the test fixture, and reported at startup as not yet used by the
  server itself.
- **One user, one context.** `resolveUserId` answers `LOCAL_USER_ID` and the
  transport refuses anything else with `unauthorized`. That refusal is
  unreachable today and exists so the seam is visible from the request path.
- **No TLS, no CORS, no compression.** The server binds `127.0.0.1` by default
  and S8.5 puts an ALB in front of it. A browser on another origin cannot call it
  until S8.3 decides what `Access-Control-Allow-Origin` should say.
- **No WebSocket resume.** A client that disconnects mid-run misses the deltas it
  was not there for and recovers by re-reading the messages, which is the same
  contract the Electron transport has (`../backend-client/implement.md`). A
  reconnecting browser makes that recovery matter more than it did, and S8.3
  should confirm the store really does converge.
- **No ping/pong or idle timeout on the socket.** A dead client that never sent a
  FIN holds an entry in the fan-out set until the OS notices. S8.4.
- **stdio MCP servers still spawn child processes.** Nothing stops them on this
  host, and on a shared one they must be stopped; PLAN's "Online version" says so
  and S8.3's capabilities are where the switch belongs.
- **`pg` and `ws` are production dependencies and therefore ship in the dmg.**
  Nothing in the Electron bundle imports either, but electron-builder prunes to
  `dependencies` and would copy them into `node_modules`. They are small (a few
  hundred kilobytes between them) and they have to be `dependencies` because the
  server needs them at runtime and `vite.server.config.ts` derives its externals
  from that list. A `files` exclusion in `electron-builder.yml` would drop them
  and needs `npm run e2e:packaged` run afterwards; it is in the Phase 6 backlog
  beside the identical note about the `better-sqlite3` prebuilds.
- **The Postgres migration SQL has never been applied on this machine** — it has
  no Docker and no Postgres. It is verified by the drift test against the schema
  it must produce, and by review. The first `docker compose up` is its first real
  execution.
