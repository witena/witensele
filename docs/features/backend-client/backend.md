# backend-client — Backend

> Status: S1.1 ships the shared contract only. The preload bridge, the handler
> registry and the event bus described here are implemented in S1.3; the table
> rows marked *planned* do not exist yet.

## Modules

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | Domain types, `LOCAL_USER_ID`, `DEFAULT_CHAT_SETTINGS`, `DEFAULT_APP_SETTINGS` (exists) |
| `src/shared/events.ts` | `BackendEvent`, `MessageDelta`, `EventOf` (exists) |
| `src/shared/backend.ts` | `BackendApi`, `BackendClient`, `BACKEND_METHODS`, `isBackendMethod` (exists) |
| `src/shared/index.ts` | Single import point for the three above plus `version.ts` (exists) |
| `src/preload/index.ts` | *Planned S1.3*: exposes `invoke(method, input)` and `subscribe(listener)` on `window.witena`, rejecting any method name that fails `isBackendMethod` |
| `src/main/ipc/index.ts` | *Planned S1.3*: the handler registry — a `Partial<BackendApi>` map, one `ipcMain.handle` per entry, plus a startup assertion that every registered key is in `BACKEND_METHODS` |
| `src/main/ipc/system.ts` | *Planned S1.3*: `system.ping` and `system.emitTestEvent` |
| `src/main/events/bus.ts` | *Planned S1.3*: the Electron-free event bus; services `emit(event: BackendEvent)` and `src/main/ipc/` is the only place that forwards to `webContents.send` |

The split matters for CLAUDE.md rule #5: services take the bus by injection and
never import electron, so the whole layer moves to a Node server by replacing
only `src/main/ipc/` and the preload bridge.

## Database

This feature owns no tables. It defines the types that S1.2's drizzle schema is
built to satisfy, so the mapping is worth stating:

| Table | Column | Type | Notes |
|---|---|---|---|
| every table | `id` | `text` | UUID string, matches `EntityBase.id` |
| every table | `user_id` | `text` | `LOCAL_USER_ID` in the desktop build |
| every table | `created_at` / `updated_at` | `integer` | Epoch milliseconds, **not** SQLite `datetime` text |
| `providers` | `api_key_encrypted` | `blob` | Never read into a `Provider`; only its presence becomes `hasApiKey` |
| `agents` | `avatar`, `params`, `skill_names`, `mcp_server_ids` | `text` (json) | Serialized `AgentAvatar`, `AgentParams`, `string[]` |
| `chats` | `settings`, `workdir` | `text` (json), `text` nullable | `ChatSettings`; `workdir` reserved, always `null` in the MVP |
| `messages` | `parts`, `usage`, `mentions` | `text` (json) | `MessagePart[]`, `Usage`, `string[]` |

Migrations: none — S1.2 introduces the first one.

## IPC handlers

*Planned S1.3.* Channel names are the method names themselves, taken from
`BACKEND_METHODS`, so preload and main cannot disagree about a channel.

| Channel | Input | Output | Errors |
|---|---|---|---|
| `system.ping` | none | `'pong'` | — |
| `system.emitTestEvent` | `{ payload: string }` | `void` | `validation` when `payload` is not a string |
| every other `BACKEND_METHODS` entry | see `implement.md` | see `implement.md` | `internal` until the owning step implements it |

Failure rules the registry enforces:

- An unknown method name is rejected in preload before it reaches IPC
  (`isBackendMethod`), so a compromised renderer cannot probe arbitrary channels.
- A handler throwing anything is normalized into a `BackendError`
  (`code`, `message`, `details?`) before it crosses the boundary; an `Error`
  instance does not survive structured clone with its prototype intact.
- An aborted run rejects with `code: 'aborted'`, which the renderer treats as a
  normal outcome rather than a failure toast.
- `providers.testConnection` and `mcp.testConnection` **resolve** with an `ok:
  false` result instead of rejecting: a failed connection test is an expected
  answer, not an exception.

## Events emitted

The main process emits the full `BackendEvent` union over one push channel; the
table in `implement.md` lists each event and its trigger. This feature emits only
one of them itself:

| Event | Payload | Emitted when |
|---|---|---|
| `system.test` | `{ payload }` | *Planned S1.3*: `system.emitTestEvent` was invoked — the acceptance probe for the push direction |

## Filesystem

Nothing. `SkillMeta.path` and `MemoryEntry.path` are declared here, but the files
they point at are owned by `../skills/` and `../memory/`.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| electron `contextBridge` / `ipcRenderer` | *Planned S1.3*: the transport under `BackendClient` | Only primitives and plain data cross `contextBridge`; functions and class instances do not. This is exactly why every shared type is JSON-serializable and errors are plain `BackendError` objects rather than `Error` subclasses |
| electron structured clone | *Planned S1.3*: payload serialization | It preserves `undefined` and does **not** preserve prototypes. Do not rely on either — a future HTTP transport goes through `JSON.stringify`, which drops `undefined` keys, so treat an absent optional field and an explicit `undefined` as the same thing |
| TypeScript 5.9 | The contract itself | `exactOptionalPropertyTypes` is on: `baseUrl?: string` will not accept an explicit `undefined`, so build the object without the key rather than setting it to `undefined`. `verbatimModuleSyntax` is on: type-only imports must say `import type` |
| vitest `expectTypeOf` | Type-level assertions in `contracts.test.ts` | They are erased at runtime, so they only fail under `npm run typecheck`, never under `npm test`. Both commands are part of the gate for that reason |
