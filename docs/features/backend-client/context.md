# backend-client — Context

## Problem

The renderer needs one way to ask the backend for things and one way to hear
about what it is doing, and that way must not be Electron. Witena is a desktop
app today, but the plan already commits to a server version, a VS Code extension
and a headless Node runtime — all three reuse this renderer. So the pages talk to
a single `BackendClient` interface and never see `ipcRenderer`, `window.witena`
or a channel name. Swapping Electron IPC for HTTP + WebSocket has to be a change
in one file, not a change in every page.

S1.1 defined the contract. S1.3 implemented the transport underneath it and the
first handlers on top of it, so the same boundary now exists at runtime and not
only in the type system.

## Scope

**The contract (S1.1)**

- `src/shared/types.ts` — the domain types every layer agrees on: providers,
  agents, MCP servers, chats, members, messages and their parts, presence,
  settings, skills, memory entries, errors.
- `src/shared/events.ts` — `BackendEvent`, the discriminated union of everything
  the backend pushes, including the streaming delta shape.
- `src/shared/backend.ts` — `BackendApi` (every request/response method with its
  input and result types), `BackendClient` (`invoke` + `subscribe`) and
  `BACKEND_METHODS` (the same method names as data, for channel registration).
- `src/shared/index.ts` — one import point for all of the above.
- `src/shared/contracts.test.ts` — runtime and type-level tests over the contract.

  The surface has grown several times since S1.1 declared it, and each addition
  follows the same three steps: the method on `BackendApi`, its name in
  `BACKEND_METHODS`, and a case in `contracts.test.ts` (S5.3
  `providers.authStatus` / `login` / `logout` and S5.13's
  `providers.setQuotaProject`, S5.4 `permission.reply`, S5.6 `chat.handoff`,
  S5.15 `permissions.grants.list` / `permissions.grants.revoke`). The
  compile-time `Assert` below makes the first two inseparable.

  S5.15 also gave one feature a **second** namespace, which is worth stating
  because it reads like a mistake: `permission.reply` answers *a* prompt, and
  `permissions.grants.*` manages the standing grants of a chat. Folding the
  second into the first would have made `permission.grants.revoke` read as an
  operation on the pending request.

**The transport (S1.3)**

- `src/main/events/bus.ts` — the Electron-free `EventBus` every service emits on.
- `src/main/secrets.ts` — the `SecretStore` interface and the insecure
  development fallback.
- `src/main/app-context.ts` — `AppContext`, the single object a handler receives,
  including the injected `userDataDir` every filesystem-backed feature derives
  its directory from (S3.2).
- `src/main/handlers/` — one module per namespace plus `buildHandlers()`, which
  returns a **total** map over `BACKEND_METHODS`.
- `src/main/ipc-protocol.ts` — the channel names, the response envelope and
  `toBackendError`, shared by main and preload and free of electron.
- `src/main/ipc/` — the only Electron-aware backend code: `register.ts`
  (`ipcMain.handle` plus event forwarding), `secret-store.ts` (`safeStorage`),
  `dialogs.ts` (`system.pickFolder`, S3.2, plus `system.pickSavePath` and
  `system.pickPaths`, S5.10), `theme.ts` (`system.applyTheme`,
  S5.8) and `editor.ts` (`system.openInEditor`, S5.7) — the methods that need a
  window, see [`backend.md`](./backend.md).
- `src/preload/index.ts` / `index.d.ts` — the `window.witena` bridge.
- `src/renderer/src/lib/backend.ts` — `createElectronBackendClient` and the
  `backend` singleton, the only renderer file that knows a transport exists.
- `e2e/smoke.spec.ts` — the Playwright harness that drives the real stack.

## Out of scope

| Not here | Owned by |
|---|---|
| Implementing any method beyond `system.*` and `settings.*` | The step that owns each domain (S1.6 providers, S1.7 chats, S2.1 agents, …). As of S3.3 they have all landed; the three `pick*` dialogs (S3.2, S5.10), `system.applyTheme` (S5.8) and `system.openInEditor` (S5.7) are the ones whose implementations live in `src/main/ipc/` rather than in a handler module — the last of them only half, see [`editor`](../editor/backend.md) |
| A React context that injects a fake client into pages | Deferred to S1.5 / S1.7, when the first store and page exist; until then the `backend` singleton is imported directly and tests use `createElectronBackendClient(fakeBridge)` |
| Database schema and persistence | `../database/`, S1.2 |
| Provider presets (`shared/presets.ts`) and real key encryption on a live provider | `../providers/`, S1.6 |
| Runtime validation beyond what the implemented handlers need | The handler that owns the method; the contract itself is type-level only |
| Translating `BackendError.code` into UI copy | `../i18n`, S1.4 |

## Dependencies

The shared half depends on nothing — it is the bottom of the stack and imports no
electron, no node built-in and no renderer code. The transport half depends on
`../database/` (the repositories an `AppContext` carries) and on electron, but
only inside `src/main/ipc/`, `src/main/index.ts` and `src/preload/`.

Everything else depends on this feature: `../providers/`, `../agents/`,
`../chats/`, `../orchestration/`, `../presence/`, `../mcp/`, `../skills/`,
`../memory/` all take their types from here and their storage, events and secrets
from the `AppContext`, and every renderer feature reaches the backend only
through `BackendClient`.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| One `invoke(method, input)` over a method-name union | One IPC channel per domain; a generated RPC client | A single channel keeps preload trivial and lets the transport change without touching call sites; the union keeps it fully typed |
| One `BackendEvent` union on one push channel | A channel per event topic | A new event costs one union member instead of a channel on three layers, and the whole stream forwards over one WebSocket unchanged |
| Single object argument per method | Positional arguments | Adding an optional field is never a breaking change at any layer |
| Epoch milliseconds as `number` for every timestamp | ISO strings; `Date` | `Date` does not survive JSON; mixing the two is the classic source of off-by-a-timezone bugs. One representation, chosen once |
| API keys are write-only (`ProviderInput.apiKey` in, `Provider.hasApiKey` out) | Returning a masked key | A key the renderer never receives cannot leak through a devtools inspection, a log line or a crash report |
| System copy travels as an i18n key plus params (`SystemNoticePart`) | Localized sentences from the backend | The backend does not know the UI language, and stored messages outlive a language change |
| Declare the whole MVP method surface in S1.1 | Add methods step by step | The renderer can be written against the finished contract, and `BACKEND_METHODS` gives S1.3 a complete channel list; unimplemented methods simply reject |
| `BACKEND_METHODS` kept in sync by a compile-time exhaustiveness check | Deriving the array from the type (impossible) or trusting review | `satisfies` rejects an unknown name and the `Assert<…>` type rejects a method missing from the array, so the two cannot drift |
| **Every `invoke` resolves with an `{ ok, value }` / `{ ok, error }` envelope** | Rejecting the `ipcMain.handle` promise | Electron flattens a rejected handler promise to its message string; `code` and `details` would be lost and the renderer could not switch on them. The envelope carries the whole `BackendError` and the client throws it again on its own side |
| **`buildHandlers()` returns a total map, filling gaps with a rejecting stub** | A partial map plus a presence check in the transport | The transport stays free of "is it implemented yet" logic, a missing method fails with a message naming the step instead of `undefined is not a function`, and a unit test can assert completeness against `BACKEND_METHODS` |
| **Handlers are `(ctx, input)` functions, not methods on a class** | A service object holding the database; module-level singletons | Nothing to construct, nothing to mock, no import cycle, and the same functions serve a Node server that builds its own `AppContext` |
| **The preload bridge does not decode the envelope** | Unwrapping in preload and rejecting there | Preload is the layer a different transport does not have. Keeping the decode in `lib/backend.ts` means an HTTP client reuses the error-rebuilding code instead of reimplementing it |
| **Two channel constants (`witena:invoke`, `witena:event`)** | One channel per method name from `BACKEND_METHODS` | 35 registrations buy nothing: the method name is already the first argument and is validated with `isBackendMethod` before dispatch |
| **`SecretStore` falls back to base64 with a `plain:` marker** | Refusing to start when `safeStorage` is unavailable | The app must still run on a machine with no keyring (CI, a fresh Linux session). The prefix makes the downgrade visible in the database and the store warns on first use |
| **`WITENA_USER_DATA` overrides `app.getPath('userData')`** | Pointing the e2e test at the real database; injecting a database path only | The whole userData directory moves, so skills and memory land in the temporary directory too when they arrive, and no test run can touch a developer's real data |
| **End-to-end coverage with Playwright's Electron driver** | Only unit tests with a fake bridge; spectron | The acceptance criterion is a round trip through preload, `contextBridge` and structured clone — exactly the parts a fake bridge cannot exercise. Playwright drives the real binary and needs no browser download |

## Open questions

- ~~`messages.list` pages with `before: string` (an exclusive message id cursor).~~
  Settled in S1.2: the message table carries a per-chat monotonic `seq` assigned
  at insert, and the repository resolves the cursor id to its `seq`. See
  [`../database/context.md`](../database/context.md).
- `providers.fetchModels` / `providers.testConnection` accept either a saved id
  or an unsaved draft (`ProviderRef`). If the settings form ends up always
  saving first, the `draft` half can be dropped.
- The three `providers.auth*` methods take `{ type }` since S5.13, and took no
  argument in S5.3 because `ant` was the only CLI. Adding Google could have meant
  three more methods; it means one more argument instead, because the question is
  the same question asked of a different machine fact. `providers.setQuotaProject`
  is deliberately *not* `{ type }`-shaped: a quota project is a Google concept
  with no Anthropic counterpart, and a method that is meaningless for half of its
  own argument's values is worse than one named after what it does. Within one
  vendor, the original limitation stands: each CLI has one active profile and
  Witena stores no credential of its own. A build that supported several logins
  *of the same vendor* would have to name which one, and the status would stop
  being a fact about the machine.
- `InvokeResponse` is written twice: once in `src/main/ipc-protocol.ts` for main
  and preload, once in `src/preload/index.d.ts` for the renderer, because the
  renderer's TypeScript project may not pull files out of `src/main/`. If a third
  copy is ever needed, move the envelope into `src/shared/`.
- Events are broadcast to every window. With a single window that is exactly
  right; a multi-window build would want per-window filtering, most likely by
  chat id.
