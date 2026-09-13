# backend-client — Implementation

## Approach

Four files in `src/shared/`, none of which imports anything outside that
directory. They are pure types plus three constants, so they compile into every
process without pulling a runtime along.

| File | Owns |
|---|---|
| `src/shared/types.ts` | Domain types and the two default-settings constants |
| `src/shared/events.ts` | `BackendEvent` and the streaming `MessageDelta` |
| `src/shared/backend.ts` | `BackendApi`, `BackendClient`, `BACKEND_METHODS`, `isBackendMethod` |
| `src/shared/index.ts` | Re-exports the three above plus `version.ts` |

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

## Data flow

Request/response, as it will run from S1.3 onward:

```
component → zustand store action → BackendClient.invoke('chats.create', { input })
  → preload bridge (ipcRenderer.invoke on the channel named by the method)
  → main handler registry → domain service → SQLite
  → result → store → re-render
```

Streaming output (the reason `subscribe` exists):

```
AgentTurn streamText chunk → event bus
  → main forwards BackendEvent over one push channel
  → preload listener → BackendClient.subscribe → messages store
  → the streaming message re-renders
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

Error path: `invoke` rejects with a `BackendError` (`code`, `message`,
`details?`). The renderer switches on `code` to choose an i18n key; `message` is
developer-facing detail for logs, never shown as UI copy.

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
| `system.ping` | — | `'pong'` | S1.3 acceptance |
| `system.emitTestEvent` | `{ payload }` | `void` | Makes the backend push one `system.test` event |
| `settings.get` | — | `AppSettings` | |
| `settings.update` | `{ patch }` | `AppSettings` | Shallow merge; `timeouts` merges per field |
| `providers.list` / `get` / `create` / `update` / `delete` | — / `{ id }` / `{ input }` / `{ id, patch }` / `{ id }` | `Provider[]` / `Provider` / `Provider` / `Provider` / `void` | Omitting `apiKey` in a patch keeps the stored key; `''` clears it |
| `providers.fetchModels` | `{ provider: ProviderRef }` | `string[]` | `ProviderRef` is `{ id }` or `{ draft }`, so an unsaved form can fetch |
| `providers.testConnection` | `{ provider: ProviderRef }` | `ConnectionTestResult` | Result object, not a rejection: a failed test is a normal outcome |
| `agents.list` / `get` / `create` / `update` / `delete` | — / `{ id }` / `{ input }` / `{ id, patch }` / `{ id }` | `Agent[]` / `Agent` / `Agent` / `Agent` / `void` | |
| `mcp.list` / `create` / `update` / `delete` | — / `{ input }` / `{ id, patch }` / `{ id }` | `McpServer[]` / `McpServer` / `McpServer` / `void` | |
| `mcp.testConnection` | `{ id }` | `McpConnectionTestResult` | Success also returns `toolNames` |
| `skills.list` / `skills.import` | — / `{ sourcePath }` | `SkillMeta[]` / `SkillMeta` | |
| `memory.list` / `read` / `write` | `{ agentId }` / `{ agentId, path }` / `{ agentId, path, content }` | `MemoryEntry[]` / `{ path, content }` / `MemoryEntry` | `path` is relative to the agent's memory directory; `MEMORY.md` is the index |
| `chats.list` / `get` / `create` / `update` / `delete` | — / `{ id }` / `{ input }` / `{ id, patch }` / `{ id }` | `Chat[]` / `Chat` / `Chat` / `Chat` / `void` | `chats.create` takes a partial input; defaults come from `DEFAULT_CHAT_SETTINGS` |
| `chats.members.set` | `{ chatId, agentIds }` | `ChatMember[]` | Replaces the whole list; array order becomes `position` |
| `messages.list` | `{ chatId, before?, limit? }` | `Message[]` | Newest first; `before` is an exclusive message-id cursor |
| `chat.send` | `{ chatId, text, mentions? }` | `Message` | Resolves with the stored user message; agent output arrives as events |
| `chat.stop` | `{ chatId }` | `void` | Idempotent when nothing is running |

| Event | Payload | Emitted when |
|---|---|---|
| `message.created` | `{ message }` | A message row is inserted, usually empty and `streaming` |
| `message.delta` | `{ chatId, messageId, delta }` | Each streamed increment; see the delta table above |
| `message.updated` | `{ message }` | The message reaches its final status / usage / error |
| `chat.updated` | `{ chat }` | A chat is created or its title or settings change |
| `chat.deleted` | `{ chatId }` | A chat is removed |
| `presence.changed` | `{ presence }` | `AgentSupervisor` moves an agent between the four states |
| `run.started` | `{ chatId, round }` | A user message starts a run |
| `run.round` | `{ chatId, round, speakers }` | A round begins, with its speaker ids in order |
| `run.finished` | `{ chatId, reason }` | The run ends: `completed` / `stopped` / `max-rounds` / `error` |
| `permission.requested` | `{ requestId, chatId, agentId, toolName, input }` | Reserved for the executor's confirmation prompt; nothing emits it yet |
| `system.test` | `{ payload }` | `system.emitTestEvent` was called (S1.3 acceptance) |

## Tests

| File | Covers |
|---|---|
| `src/shared/contracts.test.ts` | `BACKEND_METHODS` matches a hand-written expected list, has no duplicates, uses `namespace.method` names and covers the expected namespaces; `isBackendMethod` accepts and rejects correctly; `DEFAULT_CHAT_SETTINGS` and `DEFAULT_APP_SETTINGS` hold the documented values; `LOCAL_USER_ID` is `'local'`; `expectTypeOf` assertions for `EventOf<…>` narrowing, single-object method inputs, `system.ping` returning `Promise<'pong'>`, `Provider` having no `apiKey`, `Message` timestamps being numbers, `system-notice` carrying a key rather than text, and `subscribe` returning an unsubscribe function |

The expected method list is written by hand on purpose: a list derived from
`BackendApi` would follow a rename instead of failing on it.

## Known limitations and TODOs

- **Type-level only.** No runtime validation of inputs. Each handler in S1.3 and
  later validates its own payload, most likely with zod, and rejects with
  `code: 'validation'`.
- **Most methods are declared but unimplemented.** S1.3 wires
  `system.ping` and `system.emitTestEvent`; every other method rejects until its
  own step lands.
- **`subscribeTo` is optional** on `BackendClient`. The Electron implementation
  will provide it; a future transport may not, so callers must tolerate it being
  absent or use `subscribe` directly.
- **No backpressure or replay.** Events are fire-and-forget. A renderer that was
  not listening during a run recovers by calling `messages.list`, not by
  replaying events.
- **`messages.list` cursor** is a bare message id. S1.2 made that safe by giving
  every message a per-chat `seq`, which the repository resolves the id to; the
  order is total even for messages written in the same millisecond.
