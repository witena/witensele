# server — Frontend

**This feature has no renderer code yet, on purpose.** S8.1 builds the host; the
client that talks to it is S8.3 (`HttpBackendClient`, the web build of
`src/renderer/`, and `system.capabilities`). The document is here because every
feature keeps four (CLAUDE.md rule #2), and because what it records now is the
constraint S8.3 inherits.

## Pages and components

| File | Responsibility |
|---|---|
| — | None. No file under `src/renderer/` was added or changed by S8.1 |

The rule that makes this possible is CLAUDE.md #6: the renderer reaches the
backend only through `BackendClient`. The server implements the same
`BackendApi`, so a page that runs against Electron IPC runs against HTTP without
a line changing — which is a claim S8.3 gets to test and S8.1 only sets up.

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| — | — | — | No store field is added or read |

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| — | — | Nothing in the renderer calls this feature yet |

What a future client will do, and what the transport therefore guarantees:

| It will | The server does |
|---|---|
| `POST /api/<method>` with the method's single argument as the body | Answer `{ ok, value }` or `{ ok, error }` — the **same envelope** the preload bridge returns, so `HttpBackendClient` can reuse its unwrapping |
| Open one WebSocket to `/ws` and feed every frame to the same listeners `subscribe` already serves | Send one `BackendEvent` per frame, as `JSON.stringify` produced it, to every open client |
| Ask which features the host has | Not yet — `system.capabilities` is S8.3. Until then the electron-only methods reject with a message naming the file that would implement them |

## Interaction states

The states below belong to the client S8.3 writes; they are listed so that step
starts from the transport's actual behaviour rather than from a guess.

| State | What the user sees |
|---|---|
| idle | Nothing new. The desktop app is unchanged by this step |
| loading | A request is one `fetch`; the server answers or the socket errors. There is no partial HTTP response to render |
| streaming | Deltas arrive as WebSocket frames in emission order, identical to the IPC ones. A client that connects mid-run sees the rest of the run and recovers the beginning by re-reading messages |
| empty | `GET /healthz` is the only route that answers without state. Every `/api/` method behaves exactly as it does over IPC |
| error | A `BackendError` in the body plus a truthful status. The client throws on `ok: false` and the existing per-`code` copy applies unchanged — the server invents no new code and no new message |

## Copy and i18n

**None.** The server adds no user-facing string, which is not an oversight but
the rule: main-process text is a `SystemNoticePart` key translated in the
renderer (CLAUDE.md rule #4), and the server produces no text of its own beyond
`BackendError.message`, which is a developer-facing sentence exactly as it is over
IPC. `en.json` and `zh-CN.json` are untouched.

The log lines (`[witena] api listening on …`) are English console output, not UI
copy, and follow the same convention as `src/main/index.ts`.

## Accessibility and keyboard

Not applicable: no UI. The one thing this step owes accessibility is that it
changes nothing about the renderer, so nothing regressed.
