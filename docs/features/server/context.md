# server — Context

## Problem

Witena's business logic has been written since S1.1 so that it could one day run
somewhere other than inside an Electron main process: the handlers take their
storage, secrets and event bus by injection, and the renderer talks to a
`BackendClient` rather than to IPC. S8.1 is where that stops being a promise. It
adds a second **host** for the same backend — a plain Node process that serves
every backend method over HTTP and the event bus over a WebSocket — and the
Postgres half of the storage layer the hosted version will use.

Nothing about the product changes. A user sees no new screen, because the client
that talks to this server is S8.3's job. What changes is that the code the
desktop app runs can now be started with `npm run server` and driven with `curl`.

## Scope

- `src/server/` — the host: configuration from the environment, the `AppContext`
  built from it, `POST /api/<method>` for every entry of `BACKEND_METHODS`,
  `GET /ws` for the event bus, `GET /healthz`, and a clean shutdown on a signal.
- `npm run server` (a Vite build into `out/server/` plus `node`), and
  `vite.server.config.ts` that produces it.
- `src/main/db/postgres/` — the second drizzle schema, its migrations and
  `openPostgresDatabase`.
- `docker-compose.yml` — Postgres 16 on loopback, for development and for the
  Postgres half of the test suite.
- `src/main/db/dialects.ts` — the fixture that runs a suite against SQLite
  always and Postgres when `DATABASE_URL` is set.
- A test that proves nothing the server reaches imports electron.

## Out of scope

| Not here | Owned by |
|---|---|
| Authentication and real `userId`s | **S8.2**. Every request resolves `LOCAL_USER_ID` through `src/server/user.ts`, which is the one function S8.2 replaces |
| `HttpBackendClient` and any renderer change | **S8.3**. This step is verified with `fetch` and a `ws` client, not with the UI |
| `system.capabilities` and hiding Electron-only controls | **S8.3**. Today the electron-only methods reject with the message `handlers/system.ts` already gives them |
| `KmsSecretStore`, rate limits, structured logs, audit log | **S8.4**. The server uses `FileKeySecretStore` with the key path from an environment variable |
| A container image, RDS, ECS, ALB, CloudFront, CDK | **S8.5** |
| Serving the SPA's static files | **S8.3**. The server answers `/api/*`, `/ws` and `/healthz`, and 404s everything else |
| Running the handlers **on** Postgres | Nobody yet — see the decision below and the Phase 6 backlog entry |

## Dependencies

- [`../backend-client/`](../backend-client/context.md) for `BackendApi`,
  `BACKEND_METHODS`, `BackendEvent` and the `InvokeResponse` envelope. The server
  is a second implementation of that contract's server side; the first is
  `src/main/ipc/register.ts`.
- [`../database/`](../database/context.md) for the schema, the migrators and the
  repositories. S8.1 adds the Postgres dialect to that feature rather than
  forking it.
- [`../providers/`](../providers/context.md) for `FileKeySecretStore` and the
  startup secret migration, both of which are already Electron-free.
- Everything the `AppContext` builds — `../orchestration/`, `../agent-turn/`,
  `../mcp/`, `../memory/`, `../executor/` — is reused untouched. That is the
  claim the step exists to make, and `no-electron.test.ts` is what checks it.

Nothing depends on this feature yet. S8.2 through S8.6 all do.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| **The HTTP stack is `node:http` + `ws`** | Fastify; Hono + `@hono/node-server` | The routing surface is one literal prefix, one table lookup and two fixed paths — there is no path parameter, no content negotiation, no middleware chain, and the request body is the method's single argument. A framework would earn its keep on a REST API with fifty shapes; here it would add a dependency (plus a WebSocket plugin, because both would still reach for `ws`) to save about thirty lines of `if`. `ws` is not avoidable either way: Node has no server-side WebSocket, and S8.5's ALB terminates a real one. Fastify's schema validation would be genuinely useful, but the handlers already validate their own input because IPC needs them to — adding a second validation layer for one transport is how the two transports start disagreeing. The cost accepted is that we write the 405, the body cap and the JSON parse ourselves, which is the code in `http.ts` and is tested |
| **Two schema files, kept in step by a test** (`src/main/db/schema.ts` and `src/main/db/postgres/schema.ts`) | One neutral description that emits both dialects; one schema with a dialect switch | A generated description would have to reproduce drizzle's `$type<…>()` typing, which is what makes a change in `shared/types.ts` a compile error in the schema rather than a wrong object at runtime — and it would rewrite the file four other branches are editing. The drift test compares the two through drizzle's own table metadata (tables, column names, nullability, defaults, primary keys), so the mistake a shared description would prevent is caught anyway, in a test that needs no database and runs in 400 ms. What it deliberately does not compare is column *types*, because those differences are the reason the two files exist |
| **Migrations are generated per dialect, not written once in neutral SQL** | One `migrations/` directory applied to both | There is no dialect-neutral spelling of this schema. `created_at` holds `Date.now()`: in SQLite `integer` is dynamically sized and correct, in Postgres it is four bytes and overflowed in January 1970, so it must be `bigint`. Booleans are `integer` against `boolean`, JSON documents are `text` against `jsonb`. Beyond the types, the two have different *histories*: SQLite's four files are frozen, shipped and partly about adding a column to somebody's existing laptop database, while no Postgres database anywhere predates `0000_init.sql`. Both migrators share the splitter, the `__migrations` bookkeeping table and the one-transaction-per-file rule, so the shape a reader has to learn is the same |
| **`FileKeySecretStore` unwrapped, key path from `WITENA_SECRETS_KEY`** | Reuse `safeStorage` (impossible without electron); plaintext until S8.4 | The store is already Electron-free and already the desktop's own format, so a data directory can be moved between the two hosts. Wrapping is a `safeStorage` concept and a server has no Keychain, so the key file's `0600` is the protection until `KmsSecretStore` replaces it in S8.4 — which is written down here rather than discovered then |
| **Electron-only methods keep their existing rejections** | Overlay server-specific stubs; return `null`; omit the routes | `handlers/system.ts` already answers them with a sentence naming the file that would implement them, written for exactly this case. Omitting the routes would make `BACKEND_METHODS` and the mounted surface differ, which is the invariant the mount loop exists to keep, and `null` would be a lie the UI cannot detect. S8.3's `system.capabilities` is the mechanism that stops a browser from offering the control at all |
| **`{ ok, value }` / `{ ok, error }` — the IPC envelope — as the HTTP body**, with the status derived from the error code | A bare value with the error in the status and body; RFC 7807 `problem+json` | One envelope means `HttpBackendClient` can reuse the preload bridge's unwrapping verbatim, so there is one place in the product where a `BackendError` becomes a throw again. The status is derived so that proxies and `curl` see something truthful, but the body stays the authority, exactly as it is over IPC where there is no status at all |
| **One bus subscription for the whole server, fanned out to the sockets** | One subscription per client | A streaming run emits a delta per token. Serialising the same event once per client would be N `JSON.stringify` calls where one will do, and the frames would no longer be guaranteed identical |
| **The user is resolved before the body is read** | After parsing; inside each handler | An unauthenticated request must not be able to make the server buffer eight megabytes first. It also puts the S8.2 seam in one visible place in the request path |

## Postgres is not the server's database yet

The decision that most needs writing down, because the step's own description
asks for something the codebase's shape refuses.

`Repositories` is **synchronous**: `ctx.repos.chats.get(id, userId)` returns a
`Chat`, not a promise, because `better-sqlite3` is a synchronous driver and every
caller — the handlers, `ChatRunner`, `AgentTurn`, the `AgentSupervisor` — was
written against that. drizzle's Postgres driver is asynchronous and cannot be
made otherwise: its query builders return promises, and there is no supported way
to resolve one without yielding to the event loop.

So "the same repository interfaces over Postgres" and "the repositories' public
types must not change" cannot both hold. Three ways out were considered:

| Option | Why not (yet) |
|---|---|
| Make every repository method return a promise | It is the right eventual answer, and it is a cross-cutting refactor of the handler layer, the orchestrator, the turn and roughly a thousand test assertions. It is also exactly what S8.1 was told not to do, and it would conflict with every branch open beside this one |
| A synchronous Postgres driver (worker thread plus `Atomics.wait`) | Blocks the event loop of a server whose whole job is concurrent streaming, and drizzle's mapping layer would still have to be reimplemented by hand around it. It trades a refactor for a permanent liability |
| Two repository implementations, one per dialect | Around 800 lines of duplicated patch semantics, `optional()` mapping and `not_found` rules, on a code path nothing in production would exercise. Duplicated logic that is never run is not coverage, it is a second place to be wrong |

What S8.1 ships instead: the Postgres **schema**, **migrations**, **connection**
and **storage contract** are real, complete and tested against a live server by
`src/main/db/dialects.test.ts` when `DATABASE_URL` is set. What is missing is the
repository layer on top, and the work that unblocks it is the async refactor
above. `src/server/index.ts` says so at startup when `DATABASE_URL` is set rather
than silently opening SQLite, and the Phase 6 backlog carries the item under
"Server and editor".

## Open questions

- **Which layer becomes asynchronous first.** Making `Repositories` async makes
  the handlers async (most already are) and `ChatRunner` largely already is; the
  awkward callers are `resolveTimeouts`, `createSupervisor`'s accessors and
  `probeAgentProvider`, all of which are called from inside loops that are
  already `async`. It looks mechanical. It has not been attempted.
- **Whether the server keeps a context per user or one per request.** Today there
  is one context for one user. `AppContext` carries the `ChatRunnerRegistry`, the
  `AgentSupervisor` and the `McpManager`, none of which can be per request; a
  per-user context built lazily and evicted on idle is the obvious shape, and
  S8.2 has to decide it.
- **`chat_members` has no `userId`**, which was fine while one user owned the
  database file. With several users in one Postgres it is still scoped through
  both its foreign keys, but the query that checks it is in the repository rather
  than in the schema. S8.2 should decide whether that becomes a column.
- **Nothing serves the SPA.** S8.3 has to choose between CloudFront in front of
  S3 (PLAN's answer) and the server serving static files, which would make
  `npm run server` a complete local stack.
