# backend-client — Frontend

> Status: S1.3 implemented the renderer half. `src/renderer/src/lib/backend.ts`
> exists and works; the zustand stores below still arrive with the feature steps
> that own them. `App.tsx` currently holds a throwaway smoke screen that S1.5
> replaces.

## Pages and components

| File | Responsibility |
|---|---|
| `src/shared/backend.ts` | The `BackendClient` interface every renderer file depends on |
| `src/renderer/src/lib/backend.ts` | The Electron implementation — wraps the preload bridge, unwraps the response envelope, rebuilds the error. The **only** renderer file allowed to touch `window.witena` |
| `src/renderer/src/App.tsx` | S1.3 only: the smoke screen that exercises both directions. Replaced by the real shell in S1.5 |
| `src/renderer/src/lib/backendContext.tsx` | *Deferred*: a React context that injects the client so pages can be tested against a fake. Lands with the first store (S1.5 / S1.7); until then modules import the `backend` singleton |
| `src/renderer/src/stores/*.ts` | S1.7 onwards: the zustand stores that call `invoke` and reduce events; no component calls the client directly |

Rule (CLAUDE.md #6): components call store actions, stores call `BackendClient`,
and only `lib/backend.ts` knows a transport exists. A component that imports
`window.witena` or `ipcRenderer` is a bug regardless of whether it works.

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

Not implemented yet. The intended split, so the stores land consistently:

| Store | Field | Type | Meaning |
|---|---|---|---|
| `chats` | `chats` | `Chat[]` | Backend-owned mirror; replaced by `chats.list`, patched by `chat.updated` / `chat.deleted` |
| `chats` | `activeChatId` | `string \| null` | Local UI state only |
| `messages` | `byChatId` | `Record<string, Message[]>` | Backend-owned; loaded by `messages.list`, then mutated by the three `message.*` events |
| `messages` | `streamingIds` | `Set<string>` | Derived locally from message status; drives the cursor |
| `run` | `byChatId` | `Record<string, { round: number; speakers: string[] } \| null>` | Backend-owned; set by `run.*` events, drives the Stop button |
| `presence` | `byChatAgent` | `Record<string, AgentPresence>` | Backend-owned; replaced by `presence.changed`, drives the dots |
| `agents` / `providers` / `settings` | records | `Agent[]` / `Provider[]` / `AppSettings` | Backend-owned mirrors of their list methods |

Backend-owned state is never edited optimistically on its own: an action calls
`invoke`, and the store applies either the returned value or the event that
follows.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `invoke('system.ping')` | `App.tsx` on mount (S1.3 smoke screen) | Proves the bridge is alive end to end |
| `invoke('system.emitTestEvent', { payload })` | The smoke screen's button | Proves the push direction |
| `subscribeTo('system.test', …)` | `App.tsx` effect | Renders the last payload received |
| `invoke('settings.get' / 'settings.update')` | The smoke screen today, the settings page from S1.4 | Language, theme, timeouts |
| `subscribe(…)` | Once at app start, in the backend context provider (deferred) | Fans every `BackendEvent` out to the stores; the returned function unsubscribes on unmount |
| `invoke('providers.*')` | Settings → Providers | CRUD, `/models` fetch, connection test |
| `invoke('agents.*')` | Agents page | CRUD for the configuration form |
| `invoke('mcp.*')`, `invoke('skills.*')`, `invoke('memory.*')` | Settings and the agent configuration page | Servers, skill import, memory viewer |
| `invoke('chats.*')`, `invoke('chats.members.set')` | Chat list and member panel | Chat CRUD and membership ordering |
| `invoke('messages.list')` | Chat view on open and when scrolling up | Initial page and history paging |
| `invoke('chat.send' / 'chat.stop')` | Composer and Stop button | Starts and aborts a run |

Event handling worth writing down once:

- `message.created` → append the (empty, `streaming`) message.
- `message.delta` → `text` / `reasoning` append to the last part of that kind and
  start a new one if the last part differs; `part` pushes a whole new part. Never
  replace the message from a delta.
- `message.updated` → replace the message wholesale; this is authoritative for
  status, usage and error.
- `run.finished` → clear the run state for that chat and re-enable the composer.
- `presence.changed` → update the dot in the member panel and on that agent's
  message avatars (the dot shows the agent's *current* state, not the state at
  send time).

## Interaction states

The S1.3 smoke screen shows `…` until `system.ping` and `settings.get` resolve,
`—` until the first `system.test` event arrives, and the raw error message under
`data-testid="error"` if either call rejects. It is a test surface, not a design.

The states the real UI implements:

| State | What the user sees |
|---|---|
| idle | Composer enabled, Send active, no Stop button |
| loading | Skeleton rows in the chat list and message list while the first `list` call resolves |
| streaming | The agent's message grows token by token with a cursor, the member dot is red, Send is replaced by Stop |
| empty | Empty-state copy for no chats, no members, no providers — each with the action that fixes it |
| error | Rejected `invoke` shows a toast whose text comes from an i18n key chosen by `BackendError.code`; a message with status `error` renders inline with a retry action |
| stalled / skipped | `away` turns the dot orange with no other change; a `skipped` message renders dimmed alongside the system notice for the skip |

## Copy and i18n

This feature adds no permanent user-facing copy, but it fixes how copy reaches
the renderer:

- `SystemNoticePart` carries `key` + `params`; the renderer calls
  `t(part.key, part.params)`. The backend never sends a sentence.
- `BackendError.code` maps to `errors.<code>` in the locale files;
  `BackendError.message` is for logs only and is never rendered.

The literals in the S1.3 smoke screen (`backend:`, `language:`, `last event:`,
`Emit test event`) are the one deliberate exception; the file carries a
`TODO(S1.4): i18n` comment and is deleted in S1.5. Both `zh-CN.json` and
`en.json` gain the error keys together in S1.4.

## Accessibility and keyboard

Nothing permanent renders from this feature. The constraint it imposes: because
backend text arrives as keys rather than strings, screen-reader output follows
the UI language automatically, and no message rendered from a stored
`system-notice` can become stale in the wrong language after a language switch.

The smoke screen's `data-testid` attributes (`ping`, `language`, `last-event`,
`emit-test-event`, `error`) exist for Playwright; the real UI is located by role
and accessible name instead.
