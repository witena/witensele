# backend-client — Backend

> Status: S1.1 shipped the shared contract; S1.3 shipped the transport, the
> handler registry, the event bus, the secret store and the first four handlers.
> Rows marked *planned* still do not exist.

## Modules

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | Domain types, `LOCAL_USER_ID`, `DEFAULT_CHAT_SETTINGS`, `DEFAULT_APP_SETTINGS` |
| `src/shared/events.ts` | `BackendEvent`, `MessageDelta`, `EventOf` |
| `src/shared/backend.ts` | `BackendApi`, `BackendClient`, `BACKEND_METHODS`, `isBackendMethod` |
| `src/shared/index.ts` | Single import point for the three above plus `version.ts` |
| `src/main/events/bus.ts` | `EventBus` + `createEventBus()`. Services emit here; a listener that throws is logged and skipped so one broken window cannot abort a run |
| `src/main/secrets.ts` | `SecretStore` + `createInsecureSecretStore()`, the base64 `plain:` fallback used when the OS has no key storage |
| `src/main/app-context.ts` | `AppContext` (`db`, `repos`, `events`, `secrets`, `userId`, `runners`, `supervisor`, `mcp`, `memory`, `permissions`, `anthropicCli`, `close`) and `createAppContext({ databasePath, userDataDir, secrets, userId?, events?, fetchImpl?, anthropicCli?, runner?, supervisor?, mcp? })`. `close()` stops every run, the supervisor's loops and every pending permission prompt before closing the database |
| `src/main/handlers/types.ts` | `HandlerMap` — `BackendApi` with an `AppContext` threaded in front of each method's arguments — and `HandlerModule` (`Partial<HandlerMap>`) |
| `src/main/handlers/system.ts` | `system.ping`, `system.emitTestEvent`, the `system.pickFolder` / `system.pickSavePath` / `system.pickPaths` / `system.applyTheme` **stubs**, and `system.openInEditor`, which is half implemented here (see "The electron exceptions") |
| `src/main/handlers/settings.ts` | `settings.get`, `settings.update` |
| `src/main/handlers/presence.ts` | `presence.list`, `presence.retry` (S2.4); the state machine itself is [`presence`](../presence/backend.md)'s |
| `src/main/handlers/index.ts` | `buildHandlers()`: merges the modules and fills every remaining `BACKEND_METHODS` entry with a rejecting stub |
| `src/main/handlers/permissions.ts` | `permission.reply` — two validations over `ctx.permissions` (S5.4) |
| `src/main/ipc-protocol.ts` | `IPC_INVOKE`, `IPC_EVENT`, `InvokeResponse`, `toBackendError`. Shared with preload, imports no electron |
| `src/main/ipc/register.ts` | `registerIpc(ipcMain, ctx, handlers)` and `forwardEvents(events, getWindows)` |
| `src/main/ipc/secret-store.ts` | `createElectronSecretStore()` over `safeStorage` |
| `src/main/ipc/dialogs.ts` | The three native dialogs, layered over their stubs inside `registerIpc`: `system.pickFolder` over `dialog.showOpenDialog` (S3.2), and S5.10's `system.pickSavePath` over `dialog.showSaveDialog` and `system.pickPaths` over a multi-select `showOpenDialog` |
| `src/main/ipc/theme.ts` | `system.applyTheme` over `nativeTheme.themeSource`, layered the same way (S5.8) |
| `src/main/ipc/editor.ts` | `system.openInEditor`'s URL branch over `shell.openExternal`, layered the same way (S5.7). Owned by [`editor`](../editor/backend.md) |
| `src/main/index.ts` | Applies `WITENA_USER_DATA`, builds the secret store and the context on ready, registers IPC and event forwarding **before** the first window, closes the context on `before-quit` |
| `src/preload/index.ts` | `contextBridge.exposeInMainWorld('witena', { invoke, onEvent })` |
| `src/preload/index.d.ts` | Ambient `Window['witena']` for the renderer project |

The split is what CLAUDE.md rule #5 asks for: only `src/main/index.ts` and
`src/main/ipc/` import electron, verified with

```
grep -rl "from 'electron'" src/main | grep -v "src/main/index.ts" | grep -v "src/main/ipc/"
```

which must print nothing. Moving the backend to a Node server means replacing
`src/main/ipc/`, `src/main/index.ts` and the preload bridge — the handlers, the
context, the bus and the repositories go across untouched.

### The electron exceptions: the three `pick*` dialogs, `system.applyTheme` and half of `system.openInEditor`

Every other `BackendApi` method is a pure function of storage, the filesystem and
the network, so every other handler lives in `src/main/handlers/`. A **native
folder picker** is not: it belongs to the window system, there is no injectable
stand-in for it, and the alternative — a text field the user pastes an absolute
path into — would be a worse product for the sake of a rule.

S5.8 added the second, and the shape of the exception is what made it cheap to
add: the renderer paints the page, but the traffic lights of
`titleBarStyle: 'hiddenInset'` and the native dialogs are drawn by the platform,
and only `nativeTheme.themeSource` tells it which way. The difference from
`pickFolder` is that nothing depends on the answer — the page is already themed
by `data-theme` — so it resolves `void` and the store swallows its rejection.

So the exception is made deliberately and kept honest rather than waived:

| Layer | What it does |
|---|---|
| `shared/backend.ts` | Declares `'system.pickFolder': () => Promise<string \| null>` and `'system.applyTheme': (input: { theme: ThemeSetting }) => Promise<void>`, with the reason in each doc comment |
| `handlers/system.ts` | Implements both as **rejections** (`internal`, `PICK_FOLDER_UNAVAILABLE` / `APPLY_THEME_UNAVAILABLE`), so `buildHandlers()` stays total and a unit test gets a clear answer instead of a crash |
| `ipc/dialogs.ts`, `ipc/theme.ts` | The real ones, in the directory that may already import electron |
| `ipc/register.ts` | `const table = { ...handlers, ...dialogHandlers, ...themeHandlers }` — the overrides exist only in this transport |

S5.10 added two more of the **same** shape as the first, which is the cheapest
kind of exception to add and the reason the shape was worth keeping honest:
`system.pickSavePath` (`dialog.showSaveDialog`, for the deliverable of a
`document` goal — the file need not exist, which is what a save dialog is for)
and `system.pickPaths` (files **and** folders, multi-select, for a goal's
materials). Neither widens `pickFolder` with a mode flag, because a caller would
then have to read the flag to know whether it gets a string, a `null` or an
array. Cancelling resolves `null` for the save dialog and an **empty array** for
the multi-select, because a caller appending to a list treats "cancelled" and
"picked nothing" identically.

Every one of the three returns **absolute** paths — the platform knows no other
kind — and none of them can be confined to a directory on any platform this runs
on. So converting to the relative paths a `ChatGoal` stores, and refusing a pick
that fell outside the chat's folder, is the **renderer's** job
(`lib/workdir.ts`'s `relativeToWorkdir`); see
[`chats`](../chats/frontend.md).

S5.7 added the conditionally window-system one. `system.openInEditor` opens a `vscode://` or `cursor://` URL —
`shell.openExternal`, electron — *or* runs a command line — `node:child_process`,
not electron — and which of the two is a stored setting. So the shape had to bend
one notch: the whole decision lives in an Electron-free module
(`src/main/editor/open.ts`) that returns a **plan**, `handlers/system.ts` runs the
command plan and rejects the URL plan, and `ipc/editor.ts` runs both. A server
build with a custom editor configured therefore works unchanged, which no
previous exception could say.

| Layer | What `system.openInEditor` adds |
|---|---|
| `editor/open.ts` | `planOpenInEditor(ctx, input)` — confinement, the URL, the command and its quoting. No electron |
| `handlers/system.ts` | Runs a `command` plan; rejects a `url` plan with `OPEN_IN_EDITOR_UNAVAILABLE` |
| `ipc/editor.ts` | Runs a `command` plan, and hands a `url` plan to `shell.openExternal` |

A server build layers nothing, and the rejection is the truth: a browser cannot
hand a backend a path either, and a tab has no title bar to tint. The grep above
still prints nothing, because all three files are inside `src/main/ipc/`.

Cancelling the dialog resolves **`null`**, which is not an error — the renderer
must not show a failure for a user who changed their mind.

## Database

This feature owns no tables. It defines the types that S1.2's drizzle schema is
built to satisfy, so the mapping is worth stating:

| Table | Column | Type | Notes |
|---|---|---|---|
| every table | `id` | `text` | UUID string, matches `EntityBase.id` |
| every table | `user_id` | `text` | `LOCAL_USER_ID` in the desktop build; handlers pass `ctx.userId` |
| every table | `created_at` / `updated_at` | `integer` | Epoch milliseconds, **not** SQLite `datetime` text |
| `providers` | `api_key_encrypted` | `text` | Ciphertext produced by `ctx.secrets.encrypt`; never read into a `Provider`, only its presence becomes `hasApiKey` |
| `agents` | `avatar`, `params`, `skill_names`, `mcp_server_ids` | `text` (json) | Serialized `AgentAvatar`, `AgentParams`, `string[]` |
| `chats` | `settings`, `workdir` | `text` (json), `text` nullable | `ChatSettings`; `workdir` reserved, always `null` in the MVP |
| `messages` | `parts`, `usage`, `mentions` | `text` (json) | `MessagePart[]`, `Usage`, `string[]` |
| `messages` | `seq` | `integer` | Per-chat monotonic counter for total ordering. Not part of `Message` and never crosses IPC |
| `settings` | `data` | `text` (json) | One `AppSettings` row per user; read merges it over `DEFAULT_APP_SETTINGS` |

The database file is `app.getPath('userData')/witena.db`, resolved in
`src/main/index.ts` and passed to `createAppContext`. See
[`../database/backend.md`](../database/backend.md) for the table-by-table schema.

## IPC handlers

Two channels carry everything:

| Channel | Direction | Arguments | Reply |
|---|---|---|---|
| `witena:invoke` | renderer → main | `(method: string, input?: unknown)` | `InvokeResponse` |
| `witena:event` | main → renderer | `(event: BackendEvent)` | none |

| Method | Input | Output | Errors |
|---|---|---|---|
| `system.ping` | none | `'pong'` | — |
| `system.emitTestEvent` | `{ payload: string }` | `void` | `validation` when `payload` is not a string |
| `settings.get` | none | `AppSettings` | — |
| `settings.update` | `{ patch: AppSettingsPatch }` | `AppSettings` | `validation` when the patch is not an object or carries a key other than `language`, `theme`, `timeouts` |
| `permission.reply` | `{ requestId, decision }` | `void` | `validation` for a blank id or a decision outside `PERMISSION_DECISIONS`; `not_found` when nothing is waiting on that id (S5.4 — see [`executor`](../executor/backend.md)) |
| `chat.handoff` | `{ chatId, intent? }` | `Message` | `validation` for a blank id or an unknown `intent`, and `validation` carrying a `ValidationReason` (`handoff_no_workdir`, `handoff_no_executor`, `handoff_no_deliverable`, `handoff_run_active`) from the runner; `not_found` for an unknown chat (S5.6, S5.12 — see [`orchestration`](../orchestration/backend.md)) |
| every other `BACKEND_METHODS` entry | see `implement.md` | see `implement.md` | `internal`: `Not implemented yet: <method> (see docs/STEPS.md)` |

Failure rules the transport enforces:

- **`ipcMain.handle` never rejects.** Electron flattens a rejected handler promise
  to its message and would drop `code` and `details`, so `registerIpc` catches
  everything and resolves `{ ok: false, error: toBackendError(err) }`. The
  renderer's client throws a `BackendClientError` again on its side.
- **An unknown method name never reaches a handler.** `isBackendMethod` gates the
  lookup and an unknown name comes back as `validation`, so a compromised
  renderer cannot probe arbitrary channels.
- **A `BackendFailure` keeps its shape**; anything else becomes `internal` with
  its message, because a code the renderer switches on must be chosen
  deliberately, never inferred.
- An aborted run rejects with `code: 'aborted'`, which the renderer treats as a
  normal outcome rather than a failure toast. *(Planned with S1.7.)*
- `providers.testConnection` and `mcp.testConnection` **resolve** with an
  `ok: false` result instead of rejecting: a failed connection test is an expected
  answer, not an exception. *(Planned with S1.6 / S3.1.)*
- `providers.authStatus` resolves with a *state* for both of the conditions the
  sign-in panel exists to show — `not-installed` and `signed-out` — for the same
  reason (S5.3, and for `gcloud` since S5.13). The four `ant_*` / `gcloud_*`
  codes are kept for the calls that had to make
  the machine do something and could not: `providers.login`, `providers.logout`,
  and saving a provider that authenticates with an account.

## Events emitted

`forwardEvents(ctx.events, () => BrowserWindow.getAllWindows())` subscribes once
at startup and sends every bus event to every open window on `witena:event`.
Windows are resolved per emit rather than captured, so a window opened later
(macOS `activate`) receives events without re-registering, and a window being
torn down is skipped instead of throwing inside the bus. It returns the
unsubscribe function, which `before-quit` calls before closing the database.

| Event | Payload | Emitted when |
|---|---|---|
| `system.test` | `{ payload }` | `system.emitTestEvent` was invoked — the only event any code emits as of S1.3 |

Every other member of `BackendEvent` is emitted by the feature that owns it
(`../orchestration/`, `../agent-turn/`, `../presence/`, `../chats/`); the table in
`implement.md` lists them all.

## Secrets

`createElectronSecretStore()` wraps `safeStorage`: `encryptString` plus base64,
because `providers.api_key_encrypted` is a `text` column. When
`safeStorage.isEncryptionAvailable()` is false it returns
`createInsecureSecretStore()` instead — base64 behind a `plain:` marker, which is
**not encryption**. That path logs on construction and warns again on first use,
and the marker makes the downgrade visible in the stored row. The store is handed
to `createAppContext`, which binds `encrypt` into the repositories; decryption
stays outside storage and is used only when constructing a model client (S1.6).

## Testing hooks

`WITENA_USER_DATA`, read in `src/main/index.ts` before `whenReady`, redirects
`app.getPath('userData')` (the directory is created first, since `setPath`
requires it to exist). `e2e/smoke.spec.ts` points it at a fresh
`mkdtemp` directory, so the harness can assert that `witena.db` was created
without ever touching the developer's real database. It applies to the whole
userData directory, so skills and memory will land there too once they exist.

`npm run e2e` is `npm run build && playwright test`: Playwright launches the
built `out/main/index.js` through the real Electron binary with `args: ['.']`, so
no browser download is needed (`npx playwright install` is not part of the
setup). The spec closes the app in `afterAll`, including after a failure, so no
Electron process survives the run.

## Filesystem

Nothing of its own beyond the paths it resolves and injects. `src/main/index.ts`
asks electron for `app.getPath('userData')` once and passes it to
`createAppContext` as **`userDataDir`** (S3.2), alongside the database path
derived from it. Everything filesystem-backed is then derived from that one
field:

| Accessor | Directory | Owner |
|---|---|---|
| `databasePath` | `<userData>/witena.db` | [`database`](../database/backend.md) |
| `skillsDir(ctx)` | `<userData>/skills/` | [`skills`](../skills/backend.md) |
| `memoryDir(ctx)` → `ctx.memory` | `<userData>/memory/` | [`memory`](../memory/backend.md) |

That is the same injection rule the database already followed, and it is what
lets the skills loader and the memory store be driven from vitest against a
temporary directory. `SkillMeta.path` and `MemoryEntry.path` are declared in
`shared/types.ts`, but the files they point at belong to those two features.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| electron `contextBridge` / `ipcRenderer` | The transport under `BackendClient` | Only primitives and plain data cross `contextBridge`; functions and class instances do not. This is why every shared type is JSON-serializable and errors travel as plain `BackendError` objects rather than `Error` subclasses |
| electron `ipcMain.handle` | The request/response channel | A rejected handler promise reaches the renderer as an `Error` with only the message. Hence the `InvokeResponse` envelope — never reject out of the handler |
| electron `webContents.send` | The push channel | Throws on a destroyed window; `forwardEvents` checks `isDestroyed()` first |
| electron `safeStorage` | Encrypting provider API keys | `isEncryptionAvailable()` can be false on a machine with no keyring, and returns a `Buffer` that must be base64-encoded for a `text` column |
| electron `dialog.showOpenDialog` | `system.pickFolder` (S3.2) and `system.pickPaths` (S5.10) | Resolves `{ canceled, filePaths }` rather than rejecting when the user cancels, so the handlers answer `null` / `[]`. `pickFolder` passes `['openDirectory']` only; `pickPaths` passes `['openFile', 'openDirectory', 'multiSelections']`, which on macOS is one panel that accepts either |
| electron `dialog.showSaveDialog` | `system.pickSavePath` (S5.10) | Resolves `{ canceled, filePath }` — singular, and a **string**, not an array. `properties: ['createDirectory', 'showOverwriteConfirmation']`: a deliverable is routinely the first file in a folder that does not exist yet, which is also why nothing about the answer is checked against the filesystem |
| electron `shell.openExternal` | `system.openInEditor`'s URL branch (S5.7) | It resolves when the platform *accepted* the URL, and on macOS rejects when nothing is registered for the scheme — which is a real answer ("VS Code is not installed") and is why the renderer paints a failed chip from it |
| electron `nativeTheme` | `system.applyTheme` (S5.8), and `backgroundColor` in `src/main/index.ts` | `themeSource` accepts `'system'` verbatim and is process-wide, so it also covers windows opened later and needs no listener of ours. `shouldUseDarkColors` is the *resolved* answer and is only read where a colour is needed now |
| electron structured clone | Payload serialization | It preserves `undefined` and does **not** preserve prototypes. Do not rely on either — a future HTTP transport goes through `JSON.stringify`, which drops `undefined` keys, so treat an absent optional field and an explicit `undefined` as the same thing |
| `@playwright/test` (`_electron`) | The end-to-end harness | Needs the built output in `out/`, launches with `args: ['.']` from the repository root, and needs no downloaded browsers. Config lives in `playwright.config.ts` with `testDir: 'e2e'`; vitest excludes `e2e/` so `npm test` stays unit-only |
| TypeScript 5.9 | The contract itself | `exactOptionalPropertyTypes` is on: `baseUrl?: string` will not accept an explicit `undefined`, so build the object without the key. `verbatimModuleSyntax` is on: type-only imports must say `import type`. A `.d.ts` next to an `.ts` of the same name is excluded from the project that contains the `.ts`, which is why `src/preload/index.d.ts` restates the envelope instead of importing it |
| vitest `expectTypeOf` | Type-level assertions in `contracts.test.ts` | They are erased at runtime, so they only fail under `npm run typecheck`, never under `npm test`. Both commands are part of the gate for that reason |
