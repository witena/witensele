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
| `src/server/http.ts` | **S8.1**: the second transport — `POST /api/<method>` and `GET /ws`, over `node:http` + `ws` |

The abstraction is deliberately two-shaped. `invoke` is request/response;
`subscribe` is push. Anything a page needs must be expressible as one of the two,
which is what keeps an HTTP + WebSocket implementation possible — and, since
S8.1, what makes it actual.

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
run progress, the executor's permission prompt and its resolution (S5.4), the
auto-updater's two announcements (S7.4) and `system.test` (the S1.3 acceptance
probe). `BackendEventType` is its `type` tag and `EventOf<'message.delta'>`
narrows to a single member.

S7.4's pair is worth one note, because the obvious third member is deliberately
absent. `update.available` and `update.downloaded` are the two moments that change
what the user can *do*; there is no `update.progress`, because a percentage
changes dozens of times over a 150 MB download for a screen almost nobody has
open, and the one screen that does asks for the status when it mounts. Both fire
on the **transition**, not on the state, so a six-hourly check cannot announce the
same version twice.

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

### The second transport (S8.1)

`src/server/http.ts` mounts the same two channels over a socket. The mapping is
one-to-one and nothing below the transport can tell which host it is running
under:

| Electron | Server |
|---|---|
| `ipcMain.handle('witena:invoke', (method, input))` | `POST /api/<method>`, the body is `input` |
| `webContents.send('witena:event', event)` | one `JSON.stringify(event)` frame on `GET /ws` |
| — | `GET /healthz`, which touches nothing |

Three things are shared verbatim rather than reimplemented, and that is the
point of the arrangement:

- **`InvokeResponse`.** The HTTP body is the same `{ ok, value }` / `{ ok, error }`
  envelope, so S8.3's `HttpBackendClient` reuses `lib/backend.ts`'s decode.
- **`toBackendError`.** Both transports funnel every throw through it, so an
  unexpected failure becomes `internal` in exactly one place.
- **`isBackendMethod`.** Both validate the name before dispatching, so neither
  can reach anything outside `BACKEND_METHODS`.

What the HTTP side adds is a **status**, derived from `BackendError.code` by a
table that is total over the union (`ERROR_STATUS` in `src/server/http.ts`):
`validation` 400, `unauthorized` 401, `not_found` 404, the "the host is not in a
state to do that" family 409, `provider_error` / `mcp_error` 502, `internal` 500.
The body remains the authority, because IPC has no status and the two transports
may not disagree about what happened.

The electron-only methods are mounted like every other one and answer with the
rejection `handlers/system.ts` already gives them — `registerIpc`'s
`dialogHandlers` / `themeHandlers` / `editorHandlers` overlay is the *only* thing
the two transports do differently, which is exactly as intended: those three
files are the Electron-specific surface and the server has none.

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
| `providers.list` / `get` / `create` / `update` / `delete` | — / `{ id }` / `{ input }` / `{ id, patch }` / `{ id }` | `Provider[]` / `Provider` / `Provider` / `Provider` / `void` | Omitting `apiKey` in a patch keeps the stored key; `''` clears it. Every returned record carries S7.6's runtime `keyState` (`ok` / `unreadable` / `none`), which is filled by the handler and is **not** a column |
| `providers.fetchModels` | `{ provider: ProviderRef }` | `string[]` | `ProviderRef` is `{ id }` or `{ draft }`, so an unsaved form can fetch |
| `providers.testConnection` | `{ provider: ProviderRef }` | `ConnectionTestResult` | Result object, not a rejection: a failed test is a normal outcome |
| `providers.authStatus` / `login` / `logout` | `{ type: 'anthropic' \| 'google' }` | `ProviderAuthStatus` | S5.3, widened by S5.13. The status carries the account and whatever label that vendor gives it (organisation and workspace for `ant`, the quota project for `gcloud`) plus the expiry — **never a token**. `authStatus` never rejects for either state the panel exists to show, because "not installed" and "signed out" are states; `login` and `logout` reject `ant_missing` / `gcloud_missing` when there is no CLI to run |
| `providers.setQuotaProject` | `{ project }` | `ProviderAuthStatus` | S5.13, Google only. Runs `gcloud auth application-default set-quota-project` and answers with the new status; rejects `gcloud_no_project` when the CLI refuses the id |
| `agents.list` / `get` / `create` / `update` / `delete` | — / `{ id }` / `{ input }` / `{ id, patch }` / `{ id }` | `Agent[]` / `Agent` / `Agent` / `Agent` / `void` | |
| `mcp.list` / `create` / `update` / `delete` | — / `{ input }` / `{ id, patch }` / `{ id }` | `McpServer[]` / `McpServer` / `McpServer` / `void` | |
| `mcp.testConnection` | `{ id }` | `McpConnectionTestResult` | Success also returns `toolNames` |
| `system.pickFolder` | — | `string \| null` | **S3.2**; the first of the methods implemented in `src/main/ipc/` because they need a window. `null` means the user cancelled, which is not an error |
| `system.updateStatus` | — | `UpdateStatus` | **S7.4**; the cached status, never a network call. A build that cannot update itself answers `{ state: 'unsupported', reason }` rather than rejecting |
| `system.checkForUpdates` | — | `UpdateStatus` | **S7.4**; asks the feed and resolves with what the check left behind. It does not wait for the download, and an unreachable feed is `state: 'error'` inside a resolved status |
| `system.installUpdate` | — | `void` | **S7.4**; quits and relaunches. Rejects `validation` unless something has been downloaded |
| `system.pickSavePath` | `{ defaultDir? }` | `string \| null` | **S5.10**; the native **save** dialog, for a `document` goal's deliverable. The file need not exist, so nothing is checked here; `null` is a cancelled dialog |
| `system.pickPaths` | `{ defaultDir? }` | `string[]` | **S5.10**; files and folders, multi-select, for a goal's materials. Cancelling resolves `[]`, because a caller appending to a list treats that and "picked nothing" the same |
| `system.applyTheme` | `{ theme }` | `void` | **S5.8**. A notification, not a write — the setting is stored by `settings.update` — so it carries no state and its caller ignores a rejection. `validation` for a theme outside `THEME_SETTINGS` |
| `system.openInEditor` | `{ path, line?, chatId? }` | `void` | **S5.7**; the one that needs a window only for *some* settings — a `vscode://` URL does, a custom command line does not. `validation` with `editor_path_not_absolute` / `editor_path_outside_workdir`; owned by [`editor`](../editor/implement.md) |
| `skills.list` | — | `{ skills: SkillMeta[]; warnings: SkillWarning[] }` | S3.2. The warnings name folders that look like a skill and could not be used |
| `skills.import` | `{ sourcePath, overwrite? }` | `SkillMeta` | S3.2; refuses an existing folder name unless `overwrite` |
| `skills.read` / `skills.delete` | `{ name }` | `SkillDetail` / `void` | **Added in S3.2** |
| `memory.list` / `read` / `write` | `{ agentId }` / `{ agentId, path }` / `{ agentId, path, content }` | `MemoryEntry[]` / `{ path, content }` / `MemoryEntry` | S3.3. `path` is relative to the agent's memory directory; `MEMORY.md` is the index |
| `memory.delete` / `memory.search` | `{ agentId, path }` / `{ agentId, query }` | `void` / `MemorySearchHit[]` | **Added in S3.3** |
| `committees.list` / `get` / `create` / `update` / `delete` | — / `{ id }` / `{ input }` / `{ id, patch }` / `{ id }` | `Committee[]` / `Committee` / `Committee` / `Committee` / `void` | **S9.1**. Standing groups of agents, newest `updatedAt` first. Membership rides on the entity (`memberAgentIds`, ordered), so there is no `committees.members.*` pair: the row and its join rows are written in one transaction. `validation` for a blank or over-long name, a duplicate member or a second executor (`details.reason = 'second_executor'`, the chat rule's own); `not_found` for an unknown committee or member. Deleting one leaves its topics' members intact and emits a `chat.updated` per topic |
| `chats.list` / `get` / `create` / `update` / `delete` | — / `{ id }` / `{ input }` / `{ id, patch }` / `{ id }` | `Chat[]` / `Chat` / `Chat` / `Chat` / `void` | `chats.create` takes a partial input; defaults come from `DEFAULT_CHAT_SETTINGS`. Since **S9.1** it also takes `committeeId`: the members are the committee's, in its order, then `memberAgentIds`, de-duplicated keeping the first occurrence. `ChatPatch` deliberately omits `committeeId` — provenance is written once |
| `chats.goalStatus` | `{ chatId }` | `ChatGoalStatus` | **S5.10**. Whether the `document` goal's deliverable is on disk, and where. A query rather than a field on `Chat`, because it is a fact about the filesystem; a chat with no document goal answers `{ deliverable: null, delivered: false }` rather than rejecting |
| `chats.members.list` | `{ chatId }` | `ChatMember[]` | **Added in S1.7**: the contract had a setter but no getter, and both chat columns read the membership |
| `chats.members.set` | `{ chatId, agentIds }` | `ChatMember[]` | Replaces the whole list; array order becomes `position` |
| `messages.list` | `{ chatId, before?, limit? }` | `Message[]` | Newest first; `before` is an exclusive message-id cursor |
| `chat.send` | `{ chatId, text, mentions? }` | `Message` | Resolves with the stored user message; agent output arrives as events |
| `chat.stop` | `{ chatId }` | `void` | Idempotent when nothing is running |
| `chat.handoff` | `{ chatId, intent? }` | `Message` | S5.6, S5.12. Stores the hand-off message and starts the implement + review run; resolves as soon as it is scheduled, like `chat.send`. `intent` is `'implement'` (the default) or `'deliver'` — one method with an argument rather than two, because they differ in one paragraph of briefing and one notice key. Rejects `validation` with `handoff_no_workdir` / `handoff_no_executor` / `handoff_no_deliverable` / `handoff_run_active` in `details` |

As of **S3.3 every declared method is implemented.** The stub mechanism stays —
`buildHandlers()` still fills any gap with
`{ code: 'internal', message: 'Not implemented yet: <method> (see docs/STEPS.md)' }`,
and `handlers.test.ts` asserts the builder directly rather than through a method
that happens to be missing — so the next method added to `BackendApi` before its
step lands still rejects with a pointer instead of crashing. The two methods that
reject in the Electron-free layer *by design* are the three `pick*` dialogs and
`system.applyTheme`, and `system.openInEditor` joins them for two of its three
editor settings; see [`backend.md`](./backend.md).

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
| `permission.requested` | `{ requestId, chatId, agentId, toolName, input, risk? }` | A gated executor or `sideEffects` MCP tool is about to run and the turn is suspended (S5.4). `risk` is S5.15's command-policy verdict, present only for a `run_command` the policy called `dangerous` |
| `permission.resolved` | `{ requestId, chatId, decision }` — a `PermissionDecision`, `'aborted'` or `'timeout'` | That prompt ended, however it ended. Exactly one per `permission.requested`, so a card can be dismissed without knowing why (S5.4). `'timeout'` is S5.15's: nobody answered within `AppTimeouts.permissionTimeoutMs`, which is a different fact about the user than a denial |
| `system.test` | `{ payload }` | `system.emitTestEvent` was called — the only event emitted as of S1.3 |

## Tests

| File | Covers |
|---|---|
| `src/shared/contracts.test.ts` | `BACKEND_METHODS` matches a hand-written expected list (S5.10 added `system.pickSavePath`, `system.pickPaths` and `chats.goalStatus` to it; S7.4 the three `system.update*`), has no duplicates, uses `namespace.method` names and covers the expected namespaces; `isBackendMethod`; the default constants; `expectTypeOf` assertions over event narrowing, method inputs and results |
| `src/shared/contracts.test.ts` | `BACKEND_METHODS` matches a hand-written expected list (S5.10 added `system.pickSavePath`, `system.pickPaths` and `chats.goalStatus`; S5.15 added `permissions.grants.list` / `permissions.grants.revoke` and the `permissions` namespace beside `permission`), has no duplicates, uses `namespace.method` names and covers the expected namespaces; `isBackendMethod`; the default constants; `expectTypeOf` assertions over event narrowing, method inputs and results |
| `src/main/events/bus.test.ts` | Delivery order, payload identity, unsubscribe (twice is harmless), a throwing listener being logged without stopping the others, a listener added during delivery not receiving the in-flight event |
| `src/main/secrets.test.ts` | Insecure store round trip including empty, long and non-ASCII values; the `plain:` marker; `isAvailable()` false; exactly one warning |
| `src/main/app-context.test.ts` | The context opens a real temporary database, defaults to `LOCAL_USER_ID`, binds the repositories to the injected secret store, and `close()` is idempotent. From S3.2 it is also given `userDataDir`, from which `skillsDir()` / `memoryDir()` and `ctx.memory` are derived |
| `src/main/ipc-protocol.test.ts` | Channel names; `toBackendError` for a `BackendFailure` with and without details, an ordinary `Error`, and a non-`Error` throw |
| `src/main/handlers/handlers.test.ts` | Every `BACKEND_METHODS` entry has a handler and the map has no extras; unimplemented methods reject with `internal` and the STEPS.md message; `system.ping`; `system.emitTestEvent` emitting exactly one event and rejecting a non-string payload; `settings.get` / `settings.update` against the temporary-database fixture, including the `timeouts` field-by-field merge, unknown-key rejection and per-user scoping |
| `src/renderer/src/lib/backend.test.ts` | `createElectronBackendClient` against a fake bridge: resolving the envelope value, forwarding the single object argument, `undefined` for an argument-free method, rejecting with a `BackendClientError` that carries `code` and `details`, a malformed envelope becoming `internal`, `subscribe` / unsubscribe, `subscribeTo` filtering, independent subscribers |
| `src/main/updates/state.test.ts` | **S7.4**: the reducer, step by step — the whole `idle → checking → available → downloading → downloaded` walk, `up-to-date` and `error` with their `checkedAt`, percentages clamped and rounded, the version carried across a download and kept through a failure, and the two terminal rules (`downloaded` ignores a later check unless a *newer* version is downloaded; `unsupported` ignores everything) |
| `src/main/updates/service.test.ts` | **S7.4**: the service against a fake `Updater` — one `update.available` per transition, `update.downloaded` emitted once however often the library repeats itself, a rejected check becoming `state: 'error'` rather than a rejection, a second `check()` joining the first instead of starting a second download, a check on `start()` and again every six hours until `stop()`, `install()` refusing anything but `downloaded`, and the whole unsupported branch: a reason instead of a rejection, nothing emitted, no timer, no subscription |
| `src/renderer/src/lib/updates.test.ts` | **S7.4**: every one of the eight states reaching a distinct key that exists in `en.json` — the runtime half of CLAUDE.md rule #4, since the usage guard can only see the literal calls — the interpolations each sentence needs, and when "Check for updates" is offered |
| `src/renderer/src/stores/updates.test.ts` | **S7.4**: the mirror, a backend with no updater at all not breaking the screen, the busy flag, the two events through `applyBackendEvent`, an `available` event never undoing a finished download, and the dismissal rule — closed for this version, open again for the next |
| `e2e/updates.spec.ts` | **S7.4**: on an ordinary launch (a checkout, so the updater is genuinely absent) Settings → About says why and disables the button; with `WITENA_UPDATE_FEED` pointed at a feed the spec is holding, the request really arrives and the offered version travels feed → `electron-updater` → `UpdateService` → `update.available` → the store → the sentence on screen. The feed **holds** its answer until the test asks for it, because the launch check starts before the renderer has mounted |
| `e2e/smoke.spec.ts` | The real Electron app: `system.ping` renders `pong`, `settings.get` renders `system`, clicking the button round-trips a `system.test` event into `last-event`, and the database is created inside the `WITENA_USER_DATA` directory. Since S1.5 it navigates to Settings -> Developer first, via `openDeveloperSettings` |
| `src/server/http.test.ts` | **S8.1**: the contract over the second transport, on a real ephemeral port — `/healthz`, an argument-free method, a `not_found` serialised into a 404 *and* the IPC envelope, an unknown method, a `GET` on a method route, the electron-only rejections, a body that is not JSON, two WebSocket clients each receiving the same event as one frame, an upgrade refused on any other path, and a whole `chat.send` run against a `MockLanguageModelV4` whose `message.created` / `message.delta` / `run.finished` frames arrive over the socket and reassemble into the model's own text |
| `src/server/no-electron.test.ts` | **S8.1**: nothing the second transport reaches imports electron, followed transitively through every relative and `@shared` import |

The expected method list in `contracts.test.ts` is written by hand on purpose: a
list derived from `BackendApi` would follow a rename instead of failing on it.

## Known limitations and TODOs

- **Runtime validation is per handler.** The contract is type-level only. The
  implemented handlers check their own payload and reject with
  `code: 'validation'`; zod arrives with the first domain that needs a real
  schema.
- **`system.pickFolder`, `system.applyTheme` and (conditionally)
  `system.openInEditor` are the methods that are not transport-agnostic.** Both are declared here, stubbed in the handler
  layer and implemented in `src/main/ipc/` (`dialogs.ts`, `theme.ts`); a server
  build has to answer the first some other way (an upload, or a path field) and
  simply leaves the second rejecting — a browser tab has no window chrome to
  tint, and the page itself is themed by `data-theme` either way. Everything
  else moves across untouched.
- **The updater is transport-agnostic, but only because the library is behind a
  port** (S7.4). `src/main/updates/` imports nothing electron and would lift into
  a Node server unchanged; what would not lift is `src/main/ipc/updater.ts`, and
  a server that passes no updater gets `{ state: 'unsupported', reason:
  'development' }` — which is the truth, since a server has no bundle to replace.
  A hosted build that wanted to tell its users about a new version would
  implement the same three-method port over whatever it does have.
- **A second window would see a second `update.available`** only if the event were
  re-emitted, which it is not: the events fire on a transition of the one
  `UpdateService`, and a window opened afterwards catches up by calling
  `system.updateStatus`, which is exactly what `main.tsx` does at bootstrap.
  else moves across untouched. **S8.1 settled the server half of that
  sentence**: the Node host mounts all five like any other method and lets them
  reject; `openInEditor` with a `custom` command genuinely works there, because
  that branch is `node:child_process`. An upload dialog in place of
  `pickFolder` is S8.3's.
- **No backpressure or replay.** Events are fire-and-forget and go to every open
  window — and, since S8.1, to every open WebSocket. A renderer that was not
  listening during a run recovers by calling `messages.list`, not by replaying
  events. That recovery has never mattered much with one always-present window;
  a browser tab that slept makes it matter, and S8.3 has to confirm the store
  converges.
- **The HTTP transport has no client yet** (S8.1). It is verified with `fetch`
  and a `ws` client, not with the renderer. `HttpBackendClient` is S8.3, and so
  is deciding what `Access-Control-Allow-Origin` should say — today the server
  sets no CORS header and binds loopback.
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
