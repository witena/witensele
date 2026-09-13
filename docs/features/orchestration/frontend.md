# orchestration — Frontend

This feature has **no UI of its own**: it is a main-process scheduler. What the
user sees of it is the Stop button and the fact that replies arrive in order;
both are rendered by [`chats`](../chats/frontend.md).

## The renderer's half

| File | Responsibility |
|---|---|
| `src/renderer/src/stores/run.ts` | `activeByChat`, reduced from `run.started` / `run.round` / `run.finished`; `send` and `stop` |
| `src/renderer/src/components/chat/composer.tsx` | Renders Stop instead of Send while a run is active |
| `src/renderer/src/lib/event-bridge.ts` | Routes the three `run.*` events into the store |

| Store | Field | Type | Meaning |
|---|---|---|---|
| `run` | `activeByChat` | `Record<string, { round, speakers }>` | Backend-owned. Present = a run is in flight |
| `run` | `sendingByChat` | `Record<string, boolean>` | Local; covers the `chat.send` round trip before `run.started` arrives |

The rule the store is written around: **the run state comes from the events, not
from the local `send()` call.** A message sent during an active run is queued by
the backend and starts no second run, so a store that flipped its own flag would
show a Stop button for a run that does not exist — and leave it showing after the
real one finished. `run.test.ts` pins this down.

`stop()` likewise does not clear the state itself; `run.finished` does. The abort
takes a moment to unwind, and the button must not lie about it.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `invoke('chat.send', { chatId, text })` | The composer, on Enter or Send | Stores the message and schedules a run |
| `invoke('chat.stop', { chatId })` | The Stop button | Aborts the run and drops the queue |
| `subscribeTo('run.*')` (via the bridge) | Bootstrap | Drives the Send / Stop swap |

## Interaction states

| State | What the user sees |
|---|---|
| idle | Send button, enabled when there is a chat and some text |
| sending | Stop appears immediately — `sendingByChat` covers the gap before `run.started` |
| running | Stop stays until `run.finished`, whatever the reason |
| stopped | The button returns to Send and the interrupted message shows the "Stopped" hint |
| error | The button returns to Send; the failure is on the message row, not on the composer |

Sending while a run is active is **not** blocked: the message appears
immediately and is answered after the current run. See the decision table in
[`context.md`](./context.md).

## Copy and i18n

No keys of its own. It relies on `chat.send`, `chat.stop`, `chat.round` and — from
S2.3 — the already-present `notices.maxRoundsReached`, `notices.runStopped` and
`notices.agentSkipped`, which will arrive as `system-notice` parts and be
rendered with `translateNotice`.

## Accessibility and keyboard

Send and Stop occupy the **same slot** rather than sitting side by side: a run is
either happening or not, and two controls would leave the user guessing which one
applies. Both are reachable by keyboard in the composer's tab order, and the
icon-only Send carries a translated `aria-label`.
