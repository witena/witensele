# backend-client — Context

## Problem

The renderer needs one way to ask the backend for things and one way to hear
about what it is doing, and that way must not be Electron. Witena is a desktop
app today, but the plan already commits to a server version, a VS Code extension
and a headless Node runtime — all three reuse this renderer. So the pages talk to
a single `BackendClient` interface and never see `ipcRenderer`, `window.witena`
or a channel name. Swapping Electron IPC for HTTP + WebSocket has to be a change
in one file, not a change in every page.

## Scope

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

S1.1 defines the contract only. The single runtime helper it ships is
`isBackendMethod`, plus the two default-settings constants.

## Out of scope

| Not here | Owned by |
|---|---|
| The preload bridge, the main-process handler registry, the renderer's `lib/backend.ts` | S1.3, documented in `frontend.md` / `backend.md` of this feature |
| Actually implementing any method beyond `system.ping` / `system.emitTestEvent` | The step that owns each domain (S1.6 providers, S1.7 chats, S2.1 agents, …) |
| Database schema and persistence | `../chats/`, S1.2 |
| Provider presets (`shared/presets.ts`) | `../providers/`, S1.6 |
| Validation of inputs at runtime (zod schemas) | The handler that owns the method; the contract is type-level only |

## Dependencies

This feature depends on nothing — it is the bottom of the stack and imports no
electron, no node built-in and no renderer code. Everything else depends on it:
`../providers/`, `../agents/`, `../chats/`, `../orchestration/`,
`../presence/`, `../mcp/`, `../skills/`, `../memory/` all take their types from
here, and every renderer feature reaches the backend only through
`BackendClient`.

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
| Reserved-but-unused members carried now (`AgentRole.executor`, `diff` / `file-ref` parts, `permission.requested`, `Chat.workdir`, `McpServer.sideEffects`) | Adding them when the features land | PLAN.md commits to them; reserving them now keeps the stored message and chat shapes stable, so no migration is needed later |

## Open questions

- `messages.list` pages with `before: string` (an exclusive message id cursor).
  If a chat ever has two messages with an identical `createdAt` and ordering must
  be stable across devices, this may need to become a composite cursor.
- `providers.fetchModels` / `providers.testConnection` accept either a saved id
  or an unsaved draft (`ProviderRef`). If the settings form ends up always
  saving first, the `draft` half can be dropped.
