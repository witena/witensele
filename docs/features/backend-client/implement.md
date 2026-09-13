# backend-client — Implementation

## Approach

Two halves. The **contract** is four files in `src/shared/` that import nothing
outside that directory — pure types plus three constants, so they compile into
every process without pulling a runtime along. The **transport** is the thin
layer that makes the contract real, split so that exactly two directories know
Electron exists.

| File | Owns |
|---|---|
| `src/shared/types.ts` | Domain types and the two default-settings constants |
| `src/shared/events.ts` | `BackendEvent` and the streaming `MessageDelta` |
| `src/shared/backend.ts` | `BackendApi`, `BackendClient`, `BACKEND_METHODS`, `isBackendMethod` |
| `src/shared/index.ts` | Re-exports the three above plus `version.ts` |
| `src/main/events/bus.ts` | `EventBus` and the in-process implementation |
| `src/main/secrets.ts` | `SecretStore` and the insecure fallback |
| `src/main/app-context.ts` | `AppContext` and `createAppContext` |
| `src/main/handlers/*` | One module per namespace, merged by `buildHandlers()` |
| `src/main/ipc-protocol.ts` | Channel names, `InvokeResponse`, `toBackendError` |
| `src/main/ipc/register.ts` | `registerIpc` and `forwardEvents` — the only transport code |
| `src/main/ipc/secret-store.ts` | `safeStorage` behind `SecretStore` |
| `src/preload/index.ts` | The `window.witena` bridge |
| `src/renderer/src/lib/backend.ts` | `createElectronBackendClient` and the `backend` singleton |

The abstraction is deliberately two-shaped. `invoke` is request/response;
`subscribe` is push. Anything a page needs must be expressible as one of the two,
which is what keeps an HTTP + WebSocket implementation possible.

### Domain types

Every stored entity extends `EntityBase` (`id` UUID string, `userId`,
`createdAt`, `updatedAt` epoch ms), so multi-user and sync are already
representable while the desktop build pins `userId` to `LOCAL_USER_ID`
(`'local'`). Create/update payloads are `…Input` types: `AgentInput`,
`McpServerInput` and `ChatInput` are `Omit<Entity, keyof EntityBase>`, while
`ProviderInput` is written out by hand because it differs from `Provider` — it
adds the write-only `apiKey` and drops `hasApiKey`.

A `Message` is a list of `MessagePart`s discriminated on `type`: `text`,
`reasoning`, `tool-call`, `tool-result`, plus `diff` and `file-ref` reserved for
the executor agent and editor integration, plus `system-notice`, which carries an
i18n `key` and `params` instead of a sentence.

### Events

`BackendEvent` is one union covering message lifecycle, chat changes, presence,
run progress, the reserved permission prompt, and `system.test` (the S1.3
acceptance probe). `BackendEventType` is its `type` tag and
`EventOf<'message.delta'>` narrows to a single member.

### Method names as data

`BACKEND_METHODS` repeats every key of `BackendApi` as a readonly array, because
preload and main must *iterate* the names to register channels and a type cannot
be iterated. Drift is prevented at compile time from both sides:

- `as const satisfies readonly BackendMethod[]` rejects a name that is not a
  method of `BackendApi`;
- `BackendMethodsAreExhaustive` resolves to `Assert<false>` — a type error —
  when a method exists in `BackendApi` but is missing from the array.

Verified by removing an entry and observing `tsc` fail, not only by reading.

### The transport

Two channels, both declared in `src/main/ipc-protocol.ts`, which imports no
electron so preload can share it:

| Constant | Value | Direction | Arguments |
|---|---|---|---|
| `IPC_INVOKE` | `witena:invoke` | renderer → main, with a reply | `(method, input)` |
| `IPC_EVENT` | `witena:event` | main → renderer | one `BackendEvent` |

A channel per method was considered and rejected: the method name is already the
first argument and `isBackendMethod` validates it before dispatch, so 35
registrations would buy nothing.

**The envelope.** `ipcMain.handle` never rejects. It resolves with

```ts
type InvokeResponse = { ok: true; value: unknown } | { ok: false; error: BackendError }
```

because Electron flattens a rejected handler promise into an `Error` whose
message is the original message and whose other fields are gone — `code` and
`details` would not survive, and the renderer switches on `code`. So the failure
is data on the way across and becomes an exception again in
`lib/backend.ts`, which throws a `BackendClientError` carrying `code` and
`details`.

**The context.** Every handler is a plain function of `(ctx, input)` where `ctx`
is an `AppContext`:

```ts
interface AppContext {
  db: DatabaseHandle
  repos: Repositories
  events: EventBus
  secrets: SecretStore
  userId: UserId
  close(): void
}
```

`createAppContext({ databasePath, secrets })` opens the database, builds the
repositories with `encrypt: secrets.encrypt` and creates the bus. It takes the
path rather than asking electron for it, which is what keeps everything except
`src/main/index.ts` and `src/main/ipc/` free of electron (CLAUDE.md rule #5) and
lets a unit test build the same context over a temporary file.

**Totality.** `buildHandlers()` walks `BACKEND_METHODS` and returns an entry for
every name: the implementation when a namespace module provides one, otherwise a
stub that rejects with
`BackendFailure('internal', 'Not implemented yet: <method> (see docs/STEPS.md)')`.
The transport therefore never checks whether a method exists, and a renderer
written against the finished contract gets an explicit message instead of
`undefined is not a function`.

## Data flow

Request/response, as it actually runs:

```
component → BackendClient.invoke('settings.update', { patch })
  → window.witena.invoke  (preload, contextBridge)
  → ipcRenderer.invoke('witena:invoke', method, input)
  → ipcMain.handle → isBackendMethod(method) → handlers[method](ctx, input)
  → repositories → SQLite
  → { ok: true, value } → client unwraps → the caller's promise resolves
```

Push:

```
handler (or ChatRunner, AgentTurn, AgentSupervisor) → ctx.events.emit(event)
  → forwardEvents → every BrowserWindow → webContents.send('witena:event', event)
  → preload ipcRenderer.on → BackendClient.subscribe / subscribeTo
  → the store (S1.7 onwards) → re-render
```

`message.created` arrives first with an empty, `streaming` message; then a run of
`message.delta` events; then `message.updated` with the final status, usage and
error. Delta semantics:

| `delta.kind` | Renderer does |
|---|---|
| `text` | Append `text` to the last `text` part, or start one if the last part is a different kind |
| `reasoning` | The same, for the last `reasoning` part |
| `part` | Push `part` as a whole new part (tool call, tool result, system notice) |

Deltas are increments, never a resend of the full message. Because
`message.updated` always follows with the authoritative content, a renderer that
misses deltas still converges.

Error path, end to end:

| Stage | Shape |
|---|---|
| Handler throws | `BackendFailure` (an `Error` with `code` / `details`) or any other value |
| `registerIpc` catches | `toBackendError(err)` — a `BackendFailure` keeps its fields, everything else becomes `internal` with its message |
| Wire | `{ ok: false, error: BackendError }` — plain data, survives structured clone |
| `lib/backend.ts` | Throws `BackendClientError`, an `Error` implementing `BackendError` |
| Caller | Switches on `code` to pick an i18n key; `message` is developer-facing detail and is never rendered |

## Adding a handler

1. Pick or create the namespace module under `src/main/handlers/` and export a
   `HandlerModule` (`Partial<HandlerMap>`). The method's input and result types
   come from `BackendApi`, so the compiler checks the signature.
2. Add the module to `MODULES` in `src/main/handlers/index.ts` if it is new.
   Nothing else registers anything — the method name is already in
   `BACKEND_METHODS` and its stub disappears the moment the real entry exists.
3. Validate the payload inside the handler and throw a `BackendFailure` with the
   right `code`; the renderer is untrusted input like any other client.
4. Emit on `ctx.events` for anything the renderer should learn about without
   asking.
5. Add unit tests against a context built from the `src/main/db/testing.ts`
   fixture, and extend `e2e/` only when the round trip itself is what changed.

A method that is *declared but not implemented* needs no code at all: it already
rejects with `internal` and a pointer to `docs/STEPS.md`.

## Key types and contracts

Naming conventions the whole app follows:

- Method names are `namespace.method` (`chats.members.set` nests one level
  deeper). A test asserts the shape and the namespace set.
- Every method takes at most one object argument. `{ id }`, `{ chatId }`,
  `{ input }`, `{ id, patch }` — never positional parameters.
- Timestamps are epoch milliseconds as `number`, everywhere, with no exceptions.
- Payloads are JSON serializable: no `Date`, class instance, function, `Map` or
  `Set` may appear in a shared type.
- Backend-authored user-visible text is an i18n key plus params.
- API keys enter through `ProviderInput.apiKey` and never come back out.

| Method | Request | Response | Notes |
|---|---|---|---|
| `system.ping` | — | `'pong'` | Implemented in S1.3 |
| `system.emitTestEvent` | `{ payload }` | `void` | Implemented in S1.3; makes the backend push one `system.test` event |
| `settings.get` | — | `AppSettings` | Implemented in S1.3 |
| `settings.update` | `{ patch }` | `AppSettings` | Implemented in S1.3; shallow merge, `timeouts` merges per field, unknown keys rejected |
| `presence.list` | `{ chatId }` | `AgentPresence[]` | S2.4; every member of the chat, in member order |
| `presence.retry` | `{ chatId, agentId }` | `AgentPresence` | S2.4; probes the agent's provider once. A failed probe resolves, it does not reject |
| `providers.list` / `get` / `create` / `update` / `delete` | — / `{ id }` / `{ input }` / `{ id, patch }` / `{ id }` | `Provider[]` / `Provider` / `Provider` / `Provider` / `void` | Omitting `apiKey` in a patch keeps the stored key; `''` clears it |
| `providers.fetchModels` | `{ provider: ProviderRef }` | `string[]` | `ProviderRef` is `{ id }` or `{ draft }`, so an unsaved form can fetch |
| `providers.testConnection` | `{ provider: ProviderRef }` | `ConnectionTestResult` | Result object, not a rejection: a failed test is a normal outcome |
| `agents.list` / `get` / `create` / `update` / `delete` | — / `{ id }` / `{ input }` / `{ id, patch }` / `{ id }` | `Agent[]` / `Agent` / `Agent` / `Agent` / `void` | |
| `mcp.list` / `create` / `update` / `delete` | — / `{ input }` / `{ id, patch }` / `{ id }` | `McpServer[]` / `McpServer` / `McpServer` / `void` | |
| `mcp.testConnection` | `{ id }` | `McpConnectionTestResult` | Success also returns `toolNames` |
| `skills.list` / `skills.import` | — / `{ sourcePath }` | `SkillMeta[]` / `SkillMeta` | |
| `memory.list` / `read` / `write` | `{ agentId }` / `{ agentId, path }` / `{ agentId, path, content }` | `MemoryEntry[]` / `{ path, content }` / `MemoryEntry` | `path` is relative to the agent's memory directory; `MEMORY.md` is the index |
| `chats.list` / `get` / `create` / `update` / `delete` | — / `{ id }` / `{ input }` / `{ id, patch }` / `{ id }` | `Chat[]` / `Chat` / `Chat` / `Chat` / `void` | `chats.create` takes a partial input; defaults come from `DEFAULT_CHAT_SETTINGS` |
| `chats.members.list` | `{ chatId }` | `ChatMember[]` | **Added in S1.7**: the contract had a setter but no getter, and both chat columns read the membership |
| `chats.members.set` | `{ chatId, agentIds }` | `ChatMember[]` | Replaces the whole list; array order becomes `position` |
| `messages.list` | `{ chatId, before?, limit? }` | `Message[]` | Newest first; `before` is an exclusive message-id cursor |
| `chat.send` | `{ chatId, text, mentions? }` | `Message` | Resolves with the stored user message; agent output arrives as events |
| `chat.stop` | `{ chatId }` | `void` | Idempotent when nothing is running |

Everything not marked "Implemented in S1.3" rejects with
`{ code: 'internal', message: 'Not implemented yet: <method> (see docs/STEPS.md)' }`.

| Event | Payload | Emitted when |
|---|---|---|
| `message.created` | `{ message }` | A message row is inserted, usually empty and `streaming` |
| `message.delta` | `{ chatId, messageId, delta }` | Each streamed increment; see the delta table above |
| `message.updated` | `{ message }` | The message reaches its final status / usage / error |
| `chat.updated` | `{ chat }` | A chat is created or its title or settings change |
| `chat.deleted` | `{ chatId }` | A chat is removed |
| `presence.changed` | `{ presence }` | `AgentSupervisor` moves an agent between the four states (S2.4) |
| `run.started` | `{ chatId, round }` | A user message starts a run |
| `run.round` | `{ chatId, round, speakers }` | A round begins, with its speaker ids in order |
| `run.finished` | `{ chatId, reason }` | The run ends: `completed` / `stopped` / `max-rounds` / `error` |
| `permission.requested` | `{ requestId, chatId, agentId, toolName, input }` | Reserved for the executor's confirmation prompt; nothing emits it yet |
| `system.test` | `{ payload }` | `system.emitTestEvent` was called — the only event emitted as of S1.3 |

## Tests

| File | Covers |
|---|---|
| `src/shared/contracts.test.ts` | `BACKEND_METHODS` matches a hand-written expected list, has no duplicates, uses `namespace.method` names and covers the expected namespaces; `isBackendMethod`; the default constants; `expectTypeOf` assertions over event narrowing, method inputs and results |
| `src/main/events/bus.test.ts` | Delivery order, payload identity, unsubscribe (twice is harmless), a throwing listener being logged without stopping the others, a listener added during delivery not receiving the in-flight event |
| `src/main/secrets.test.ts` | Insecure store round trip including empty, long and non-ASCII values; the `plain:` marker; `isAvailable()` false; exactly one warning |
| `src/main/app-context.test.ts` | The context opens a real temporary database, defaults to `LOCAL_USER_ID`, binds the repositories to the injected secret store, and `close()` is idempotent |
| `src/main/ipc-protocol.test.ts` | Channel names; `toBackendError` for a `BackendFailure` with and without details, an ordinary `Error`, and a non-`Error` throw |
| `src/main/handlers/handlers.test.ts` | Every `BACKEND_METHODS` entry has a handler and the map has no extras; unimplemented methods reject with `internal` and the STEPS.md message; `system.ping`; `system.emitTestEvent` emitting exactly one event and rejecting a non-string payload; `settings.get` / `settings.update` against the temporary-database fixture, including the `timeouts` field-by-field merge, unknown-key rejection and per-user scoping |
| `src/renderer/src/lib/backend.test.ts` | `createElectronBackendClient` against a fake bridge: resolving the envelope value, forwarding the single object argument, `undefined` for an argument-free method, rejecting with a `BackendClientError` that carries `code` and `details`, a malformed envelope becoming `internal`, `subscribe` / unsubscribe, `subscribeTo` filtering, independent subscribers |
| `e2e/smoke.spec.ts` | The real Electron app: `system.ping` renders `pong`, `settings.get` renders `system`, clicking the button round-trips a `system.test` event into `last-event`, and the database is created inside the `WITENA_USER_DATA` directory. Since S1.5 it navigates to Settings -> Developer first, via `openDeveloperSettings` |

The expected method list in `contracts.test.ts` is written by hand on purpose: a
list derived from `BackendApi` would follow a rename instead of failing on it.

## Known limitations and TODOs

- **Runtime validation is per handler.** The contract is type-level only. The
  implemented handlers check their own payload and reject with
  `code: 'validation'`; zod arrives with the first domain that needs a real
  schema.
- **Most methods are still stubs.** S1.3 implements `system.*` and `settings.*`;
  every other method rejects with `internal` until its own step lands.
- **No backpressure or replay.** Events are fire-and-forget and go to every open
  window. A renderer that was not listening during a run recovers by calling
  `messages.list`, not by replaying events.
- **`InvokeResponse` is declared twice** — in `src/main/ipc-protocol.ts` for main
  and preload, and in `src/preload/index.d.ts` for the renderer, whose TypeScript
  project may not include files from `src/main/`. The two must be edited
  together; a mismatch surfaces as a type error in `lib/backend.ts`.
- **Injection is a module singleton, not React context.** S1.4 added
  `src/renderer/src/lib/backend-provider.ts` (`getBackend()` / `setBackend()`)
  instead of the planned context: the bootstrap loads settings *before* the React
  tree exists, so a provider component could not supply the client to it. Tests
  swap in a fake with `setBackend`; tests of the client itself still use
  `createElectronBackendClient(fakeBridge)`.
- **The smoke UI is a test surface, not product UI.** S1.4 moved its copy into the
  locale files; S1.5 moved the widgets themselves out of `App.tsx` into Settings ->
  Developer and retired the `smoke` namespace, whose strings are
  `settings.developer.*` now. It stays because `smoke.spec.ts` and `i18n.spec.ts`
  are the only end-to-end proof the transport works until S1.7 puts a real message
  on screen.
