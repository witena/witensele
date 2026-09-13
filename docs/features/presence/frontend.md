# presence — Frontend

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/stores/presence.ts` | The store: `load` (seed), `apply` (event), `retry`, `clear`, plus the `usePresence` / `useAgentPresence` / `useIsRetrying` selectors |
| `src/renderer/src/components/ui/presence-dot.tsx` | The dot itself and `presenceColorClass`; carries `data-state` so the end-to-end specs never assert on a colour class |
| `src/renderer/src/components/ui/avatar.tsx` | Renders the dot overlaid on an avatar (`presence`, `presenceLabel`, `presenceTestId`) |
| `src/renderer/src/components/chat/member-panel.tsx` | The dot and the state label per member, "away · Ns" with a one-second tick, and the "Retry" button that replaces the usage column while a member is offline |
| `src/renderer/src/components/chat/message-item.tsx` | The dot on an **agent** message's avatar, showing that agent's *current* state |
| `src/renderer/src/pages/chats-page.tsx` | Seeds the store with `presence.load(chatId)` whenever a chat is opened |
| `src/renderer/src/pages/settings/timeouts-section.tsx` | Settings → Timeouts & heartbeat: the three budgets in seconds, the explanation and the colour legend |
| `src/renderer/src/pages/settings-page.tsx` | Routes the `timeouts` section to that component |
| `src/renderer/src/stores/settings.ts` | `setTimeouts(patch)` — a partial of `AppTimeouts`, merged field by field by the backend |

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| `presence` | `byChatAgent` | `Record<string, AgentPresence>` | Server-owned. Keyed `chatId:agentId` by `presenceKey()` |
| `presence` | `retryingByChatAgent` | `Record<string, boolean>` | Local. A `presence.retry` is in flight for that member |
| `settings` | `settings.timeouts` | `AppTimeouts` | Server-owned mirror; the section writes through `setTimeouts` and re-mirrors the answer |

Nothing about presence is persisted, in the store or anywhere else: a reload
starts from `presence.list` and the events take over from there.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `presence.list` | `stores/presence.load`, from a `chats-page` effect on `selectedId` | Seed every member's dot. The supervisor has been running since launch, so a chat opened later can already have an offline member and no event about it |
| `presence.retry` | `stores/presence.retry`, from the member panel's Retry button | Probe the provider once; the answer is applied to the store as well as emitted |
| `settings.update` | `stores/settings.setTimeouts`, from the Timeouts section | Persist one budget without resending the other two |
| `presence.changed` | `lib/event-bridge.ts` → `usePresenceStore.apply` | Every state change, from every chat |
| `chat.deleted` | `lib/event-bridge.ts` → `usePresenceStore.clear` | Drop that chat's presences |

## Interaction states

| State | What the user sees |
|---|---|
| idle | Green dot, `presence.available`, and the usage placeholder in the member row |
| working | Red dot, `presence.working`, while the agent is requesting, streaming or running a tool |
| away | Orange dot and `presence.awayFor` — "Away · 34s", counting up once a second from `lastActivityAt`. Nothing is interrupted and the message keeps its streaming cursor |
| offline | Grey dot, `presence.offline`, and the usage column is replaced by a "Retry" text button |
| retrying | The same button reads `presence.retrying` and is disabled until the probe answers; a failed probe leaves everything exactly as it was |
| loading | No separate state. An unseeded member renders at `DEFAULT_PRESENCE` (`available`) rather than blank — a missing dot would be a hole in the row |
| error | A failed `presence.list` or `presence.retry` is swallowed: a dot is cosmetic, the next event repairs it, and a red line under the member list would be worse than a stale colour |

Message avatars follow the agent's **current** state, not the state it had when
the message was written (PLAN, "Presence dots"), which is why they read the store
by agent id. User and system messages carry no dot at all.

## Copy and i18n

| Key | Used for |
|---|---|
| `presence.available` / `working` / `away` / `offline` | The four state labels, in the member panel, the message avatars' accessible names and the settings legend |
| `presence.awayFor` | "Away · {{seconds}}s" in the member row |
| `presence.retry` / `presence.retrying` | The Retry button and its pending label |
| `notices.agentSkipped` | "{{agent}} did not respond and was skipped this round" — written by the backend as a key plus params |
| `notices.allOffline` | Every member is offline, so nobody answered |
| `settings.sections.timeouts` | "Timeouts & heartbeat" in the settings nav |
| `settings.timeouts.*` | `intro`, the three labels and hints, `unit`, `perChat`, `legend` and the four `legend*` descriptions |

Every one is a literal `t('…')` inside a `switch`, so `used-keys.test.ts` can see
all four branches of both label functions.

## Accessibility and keyboard

- The dot is a `role="img"` with the translated state as its accessible name
  whenever the same word is not already printed next to it; where it is, the dot
  is `aria-hidden` and decorative.
- The Retry button is a real `<button>` in the row's tab order, with the visible
  focus ring the rest of the shell uses, and it is `disabled` while its probe runs.
- The three timeout fields are `<input type="number">` with a `<label htmlFor>`;
  Enter commits (by blurring), and an out-of-range value snaps back to what is
  stored rather than being saved.
