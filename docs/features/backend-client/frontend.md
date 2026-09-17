# backend-client — Frontend

> Status: S1.3 implemented the renderer half, S1.4 added the first store, S1.5
> replaced `App.tsx` with the real shell, and **S1.7 added the event bridge plus
> four more stores** (`chats`, `messages`, `run`, `presence`, `agents`).
> `src/renderer/src/lib/backend.ts` exists and works; the stores still missing
> arrive with the feature steps that own them. The smoke widgets now live in
> Settings -> Developer (`pages/settings/developer-section.tsx`).

## Pages and components

| File | Responsibility |
|---|---|
| `src/shared/backend.ts` | The `BackendClient` interface every renderer file depends on |
| `src/renderer/src/lib/backend.ts` | The Electron implementation — wraps the preload bridge, unwraps the response envelope, rebuilds the error. The **only** renderer file allowed to touch `window.witena` |
| `src/renderer/src/pages/settings/developer-section.tsx` | The smoke surface that exercises both directions, translated in S1.4 and moved here from `App.tsx` in S1.5. A deliberate test surface, not product UI — with one piece of real product settings since S5.7: the Editor block, which lives here because its custom mode is a shell command ([`editor`](../editor/frontend.md)) |
| `src/renderer/src/lib/backend-provider.ts` | S1.4: `getBackend()` / `setBackend()`. The injection point stores use instead of importing the singleton, so a store is testable in plain Node with a fake client. It replaced the planned `backendContext.tsx` — the bootstrap needs the client *before* the React tree exists, which a context cannot provide |
| `src/renderer/src/lib/event-bridge.ts` | S1.7: the **single** `subscribe` call for the whole renderer, started by `main.tsx` before the first render. `applyBackendEvent(event)` is its exported reducer, which the store tests drive directly |
| `src/renderer/src/stores/*.ts` | The zustand stores that call `invoke` and reduce events; no component calls the client directly. `stores/settings.ts` landed in S1.4, `stores/providers.ts` in S1.6, `chats` / `messages` / `run` / `presence` / `agents` in S1.7, and `stores/permissions.ts` in S5.5 |

Rule (CLAUDE.md #6): components call store actions, stores call `BackendClient`,
and only `lib/backend.ts` knows a transport exists. A component that imports
`window.witena` or `ipcRenderer` is a bug regardless of whether it works.

**S8.1 changed no file in this table**, which is the first evidence the rule was
worth keeping: a second transport now serves the same `BackendApi` over HTTP and
a WebSocket (`../server/`), and nothing in the renderer knows. The client that
uses it — `HttpBackendClient`, a sibling of `createElectronBackendClient` in
`lib/backend.ts` and the only file that would gain a line — is S8.3's.

### The client

```ts
import { backend } from './lib/backend'

await backend.invoke('settings.update', { patch: { language: 'en' } })
const stop = backend.subscribeTo('system.test', (event) => …)
```

- `createElectronBackendClient(bridge)` takes the bridge as a parameter, so a
  test passes a fake object with `invoke` and `onEvent` instead of standing up
  Electron.
- `backend` is that client built **lazily** around `window.witena` on first use,
  because the module is imported during bootstrap and because importing a store
  in a unit test must not fail merely for lacking a bridge.
- `invoke` resolves with `value` from the envelope, or throws a
  `BackendClientError` — an `Error` that also implements `BackendError`, so
  `error.code` is available without a type guard.
- `subscribe` receives every `BackendEvent`; `subscribeTo(type, listener)`
  filters by `type` and narrows the argument to `EventOf<type>`. Both return the
  unsubscribe function, which an effect must call on cleanup — React StrictMode
  runs effects twice in development and would otherwise double every handler.

## State

`settings` landed in S1.4, `providers` in S1.6, and the five chat stores in S1.7
(see [`../chats/frontend.md`](../chats/frontend.md)). The split, so the ones still
missing land consistently:

| Store | Field | Type | Meaning |
|---|---|---|---|
| `chats` | `chats` | `Chat[]` | Backend-owned mirror; replaced by `chats.list`, patched by `chat.updated` / `chat.deleted` |
| `chats` | `selectedId` | `string \| null` | Local UI state only (named `selectedId`, not `activeChatId`, as shipped in S1.7) |
| `chats` | `membersByChat` | `Record<string, string[]>` | Backend-owned; member agent ids in speaking order |
| `messages` | `byChat` | `Record<string, Message[]>` | Backend-owned, **oldest first**; loaded by `messages.list`, then mutated by the three `message.*` events |
| `run` | `activeByChat` | `Record<string, { round: number; speakers: string[] }>` | Backend-owned; set by `run.*` events, drives the Stop button. Absent, rather than `null`, when the chat is idle |
| `presence` | `byChatAgent` | `Record<string, AgentPresence>` | Backend-owned; replaced by `presence.changed`, drives the dots |
| `agents` / `providers` / `settings` | records | `Agent[]` / `Provider[]` / `AppSettings` | Backend-owned mirrors of their list methods |

Backend-owned state is never edited optimistically on its own: an action calls
`invoke`, and the store applies either the returned value or the event that
follows.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `invoke('system.ping')` | `DeveloperSection` on mount (S1.3 smoke widgets) | Proves the bridge is alive end to end |
| `invoke('system.emitTestEvent', { payload })` | The Developer section's button | Proves the push direction |
| `subscribeTo('system.test', …)` | `DeveloperSection` effect | Renders the last payload received |
| `invoke('settings.get' / 'settings.update')` | `stores/settings.ts` since S1.4 — `load()` from the renderer bootstrap, `setLanguage()` from the switcher, `setTheme()` from the appearance control (S5.8) | Language, theme, timeouts |
| `subscribe(…)` | `startEventBridge()` in `main.tsx`, once at app start (S1.7) | Fans every `BackendEvent` out to the stores. It is deliberately never unsubscribed: the bridge lives as long as the window, so no event can be lost between the first `list` call and the first render |
| `invoke('providers.*')` | Settings → Providers | CRUD, `/models` fetch, connection test, and (S5.3, S5.13) one vendor CLI's sign-in status, login and logout — named by `{ type }` — plus Google's quota project |
| `invoke('agents.*')` | Agents page | CRUD for the configuration form |
| `invoke('mcp.*')`, `invoke('skills.*')`, `invoke('memory.*')` | Settings and the agent configuration page | Servers, the skills library, the per-agent memory panel |
| `invoke('system.pickFolder')` | `stores/skills.ts`, behind "Import folder", and `stores/chats.ts`, behind "Choose…" | The native folder dialog. Resolves `null` when the user cancels, which the store treats as a non-event rather than an error — the first of the methods whose implementation is Electron-specific (S3.2) |
| `invoke('system.pickSavePath')` + `invoke('system.pickPaths')` | `stores/chats.ts`, behind the Goal block's "Choose…" and "Add…" (S5.10) | The native save and multi-select dialogs. Both answer **absolute** paths, which the store converts with `relativeToWorkdir` before a goal can hold them; a pick outside the chat's folder is refused by the renderer, with a `ValidationReason` in the same error fields a backend rejection would use |
| `invoke('system.applyTheme', { theme })` | `stores/settings.ts`, after a successful `settings.update` | Tints the title bar and the native dialogs (S5.8). Another Electron-specific method, and the only call in the app whose rejection is deliberately ignored: the page is already repainted, and a transport without a window must not fail the setting |
| `invoke('system.openInEditor', { path, line, chatId })` | `lib/editor.ts`, from the transcript's four clickable file surfaces | Opens a file (S5.7). The third method whose implementation may need a window, and the first that needs one only for some settings; see [`editor`](../editor/frontend.md) |
| `invoke('chats.*')`, `invoke('chats.members.list')` | Chat list and member panel, since S1.7 | Chat CRUD and reading the membership. `chats.members.set` gets its UI in S2.2 |
| `invoke('messages.list')` | Chat view on open and when scrolling up | Initial page and history paging |
| `invoke('chat.send' / 'chat.stop')` | Composer and Stop button | Starts and aborts a run |
| `invoke('chat.handoff')` | The "Hand to executor" button (S5.6), and the Actions card's "Write the deliverable" with `intent: 'deliver'` (S5.12) | Starts the implement + review run. Its four `validation` refusals are read through `translateFailure(t, code, details)`, which is why the run store keeps `errorDetails` beside `errorCode` |

Event handling worth writing down once:

- `message.created` → append the (empty, `streaming`) message.
- `message.delta` → `text` / `reasoning` append to the last part of that kind and
  start a new one if the last part differs; `part` pushes a whole new part. Never
  replace the message from a delta.
- `message.updated` → replace the message wholesale; this is authoritative for
  status, usage and error.
- `run.started` / `run.round` → set the chat's run state, which is what shows the
  Stop button. **Never** set it from the local `send()` call: a message sent
  during an active run is queued by the backend and starts no second run.
- `run.finished` → clear the run state for that chat and re-enable the composer.
- `chat.updated` → upsert by id and re-sort by `updatedAt`; `chat.deleted` → drop
  the chat together with its transcript, its presences and its run state.
- `presence.changed` → update the dot in the member panel and on that agent's
  message avatars (the dot shows the agent's *current* state, not the state at
  send time).
- `permission.requested` → add a card to `stores/permissions.ts`, carrying
  S5.15's `risk` when the backend sent one;
  `permission.resolved` → remove it, whatever the decision says. Exactly one
  `resolved` per `requested`, on every path, which is what lets the card be
  dismissed without knowing why (S5.4, drawn in S5.5).

## Interaction states

Settings -> Developer shows `…` until `system.ping` resolves, `—` until the first
`system.test` event arrives, and the raw error message under
`data-testid="error"` if a call rejects. Settings are not fetched there: S1.4
moved them into `stores/settings.ts`, which the bootstrap loads before the first
render. It is a test surface, not a design — the rest of the shell landed in S1.5
(see [`../ui-shell/frontend.md`](../ui-shell/frontend.md)).

The states the real UI implements:

| State | What the user sees |
|---|---|
| idle | Composer enabled, Send active, no Stop button |
| loading | Skeleton rows in the chat list and message list while the first `list` call resolves |
| streaming | The agent's message grows token by token with a cursor, the member dot is red, Send is replaced by Stop |
| empty | Empty-state copy for no chats, no members, no providers — each with the action that fixes it |
| error | Rejected `invoke` shows a toast whose text comes from an i18n key chosen by `BackendError.code`; a message with status `error` renders inline with a retry action |
| stalled / skipped | `away` turns the dot orange with no other change; a `skipped` message renders dimmed alongside the system notice for the skip |
| disconnected | **Not implemented, and S8.1 is why it now matters.** Over IPC the channel is there for the life of the window; over a WebSocket it can drop and come back. The recovery already documented — re-read with `messages.list` — is the right one, but nothing yet tells the user a run is streaming into a socket that closed. S8.3 |

## Copy and i18n

This feature adds no permanent user-facing copy, but it fixes how copy reaches
the renderer:

- `SystemNoticePart` carries `key` + `params`; the renderer calls
  `translateNotice(t, part)`, which resolves `notices.<key>`
  (`src/renderer/src/i18n/notices.ts`). The backend never sends a sentence.
- `BackendError.code` maps to `errors.<code>` in the locale files, added to both
  in S1.4; `BackendError.message` is for logs only and is never rendered. S8.1
  relies on that: the HTTP transport sends the same codes and invents none, so
  the existing copy covers it and neither locale file was touched.

S1.4 removed the last exception: the smoke widgets' literals moved into the
locale files and the `TODO(S1.4): i18n` comment is gone. S1.5 retired the `smoke`
namespace with the screen it was named after — those strings are the
`settings.developer.*` subtree now. See
[`../i18n/frontend.md`](../i18n/frontend.md).

## Accessibility and keyboard

Nothing permanent renders from this feature. The constraint it imposes: because
backend text arrives as keys rather than strings, screen-reader output follows
the UI language automatically, and no message rendered from a stored
`system-notice` can become stale in the wrong language after a language switch.

The smoke widgets' `data-testid` attributes (`ping`, `language`,
`resolved-language`, `last-event`, `emit-test-event`, `error`) exist for
Playwright. Each wraps a **value only**, never its translated label, so the
assertions do not depend on the active language. Since S1.5 they are no longer on
the first screen: a spec calls `openDeveloperSettings(window)` from
`e2e/helpers.ts` to get there, and the language switcher's testids (`lang-system`,
`lang-zh-CN`, `lang-en`) moved with it to the bottom of the settings nav.
