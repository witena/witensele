# <feature> — Backend

## Modules

> Every main-process file this feature owns, with one line each. Remember the
> rule: only `src/main/index.ts` and `src/main/ipc/` may import electron. Business
> logic takes its storage, secrets and event bus by injection so it can be lifted
> into a Node server later.

| File | Responsibility |
|---|---|
| | |

## Database

> Tables and columns this feature reads or writes, and the migration that
> introduced them. Every table carries `userId`, a UUID primary key, `createdAt`
> and `updatedAt`.

| Table | Column | Type | Notes |
|---|---|---|---|
| | | | |

Migrations: `<file>` — what it changes.

## IPC handlers

> The handlers registered by this feature, their validation, and their failure
> modes. Say what happens on bad input, not only on the happy path.

| Channel | Input | Output | Errors |
|---|---|---|---|
| | | | |

## Events emitted

| Event | Payload | Emitted when |
|---|---|---|
| | | |

## Filesystem

> Anything written outside the database (under `app.getPath('userData')`), with
> the layout and who owns cleanup. Delete this section if the feature stores
> nothing on disk.

## External dependencies

> How this feature uses the AI SDK, MCP SDK, or any other third-party library:
> the specific APIs called, the version-sensitive bits, and the pitfalls found the
> hard way. This section is the one that saves the most time later — be specific
> about what went wrong and what the fix was.

| Dependency | Used for | Pitfalls |
|---|---|---|
| | | |
