# ui-shell — Context

## Problem

Until S1.5 the app opened on a centred column of debug read-outs. The shell is
what turns it into a product the user can move around in: a navigation rail with
three destinations, the three-column chat layout the whole plan is shaped around,
an agent library and a settings page — all of it dark, all of it matching the
approved mockup, and all of it navigable before a single row of data exists.

It also settles the *vocabulary* every later step builds in. Buttons, inputs,
selects, badges, avatars, presence dots and empty states are defined once here,
so S1.6 and S1.7 assemble screens instead of re-inventing a button.

## Scope

- `stores/ui.ts`: the current page and the selected settings section.
- `AppShell` + `NavRail`: the frame, the rail, the active state, and the window
  drag regions required by `titleBarStyle: 'hiddenInset'`.
- The three pages as static shells: `ChatsPage` (list / conversation / member
  panel), `AgentsPage` (list / editor), `SettingsPage` (section nav / content).
- The primitives under `components/ui/` and the layout helpers under
  `components/layout/`.
- The language switch, which is the one piece of real behaviour on the page: the
  quick toggle at the bottom of the settings nav and the select in Appearance &
  language, both writing the setting S1.4 already persists.
- Settings → Developer, the new home of the transport smoke widgets the
  end-to-end specs drive.

## Out of scope

| Deliberately absent | Owned by |
|---|---|
| Chat list, messages, composer behaviour, streaming | S1.7 (`chats`, `agent-turn`) |
| Provider cards, the add/edit panel, model chips | S1.6 (`providers`) |
| The agent configuration form | S2.1 (`agents`) |
| Member add / remove / reorder, persisting chat settings | S2.2 (`chats`) |
| Message rendering, tool cards, `@` autocomplete | S2.5 |
| Live presence dots | S2.4 (`presence`) — the `PresenceDot` component exists, nothing feeds it yet |
| The Data & backup settings section | S4.x — it renders an empty state naming the step. Providers (S1.6), MCP servers (S3.1), Skills (S3.2), Appearance & language (S1.5), Timeouts & heartbeat (S2.4) and Developer have content |
| A light theme | Not planned. `AppSettings.theme` has one value; the tokens make it a swap if that changes |

The group-settings controls in the member panel are the one grey area: they are
rendered, they work, and they are **local state only**. A `ChatSettings` write
needs a chat to write it to, which is S2.2.

## Dependencies

| Depends on | For what |
|---|---|
| [`../i18n/context.md`](../i18n/context.md) | Every string. The shell adds ~45 keys and removes the `smoke` namespace |
| [`../backend-client/context.md`](../backend-client/context.md) | `getBackend()` in the Developer section; `stores/settings.ts` for the language |
| `@shared/types` | `PresenceState`, `ChatMode`, `SpeakingMode`, `DEFAULT_CHAT_SETTINGS`, `DEFAULT_APP_SETTINGS` |
| `src/renderer/src/index.css` | The design tokens. No component may write a literal colour |

Depending on it in return: every feature with a UI. `providers`, `agents`,
`chats` and `presence` all render inside these columns and from these primitives.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| A zustand field instead of a router | react-router, TanStack Router, hash routing | Three destinations, no URLs, no deep links, no history to restore. A router would be a second source of truth for one enum. If deep links ever matter (VS Code extension, server version) the router becomes the thing that writes this field, and nothing else changes |
| One page mounted at a time | Keep all three mounted and toggle `hidden` | A hidden chat page would keep subscriptions open and keep streaming into a view nobody is looking at once S1.7 lands. Remounting a static shell costs nothing |
| Native `<select>`, styled | A custom listbox | The OS draws the popup: keyboard navigation, type-ahead, VoiceOver and edge-of-screen behaviour come free. The mockup's control is a value-plus-chevron pill anyway |
| `presenceColorClass` as an exported pure function | Inline `switch` inside the component | The state → token mapping is the only logic in the file; pulling it out makes it testable with no jsdom and no React, and totality over `PresenceState` is enforced by the compiler and the test together |
| Class names written out in full, never interpolated | `` `bg-presence-${state}` `` | Tailwind scans source text. An interpolated class compiles and then renders transparent |
| `drag-region` / `no-drag` as `@utility` in `index.css` | Tailwind arbitrary properties `[-webkit-app-region:drag]`, inline styles | The leading `-` of the vendor prefix collides with Tailwind's negative-value syntax, and `WebkitAppRegion` is not in React's `CSSProperties` |
| The smoke widgets moved to Settings → Developer rather than deleted | Delete them; keep a hidden debug route | `smoke.spec.ts` and `i18n.spec.ts` are the only end-to-end proof the transport works, and nothing else is observable until S1.7. A visible settings section is cheaper than a hidden one and survives being forgotten |
| `smoke.*` strings moved under `settings.developer.*` | Keep the `smoke` namespace | The namespace belonged to a screen that no longer exists. `locales.test.ts`'s `EXPECTED_NAMESPACES` was updated with it, which is the deliberate decision its comment asks for |
| Group settings are live local state, not disabled controls | Render them `disabled` | A page of dead controls is hard to judge against the mockup. Local state shows the real interaction and is obviously temporary |
| The leftmost column headers sit 32px from the top, not 14px | Keep the mockup's 14px; use a custom title bar | macOS draws the traffic lights over the top-left of the content. The mockup has no window chrome to design around; something had to give (see [frontend.md](./frontend.md)) |

## Open questions

- The 32px traffic-light inset makes the leftmost column header sit lower than
  the 52px page header next to it. It is defensible (Slack and Discord do the
  same) but it is a real difference from the artboards; a custom title bar strip
  spanning the full width is the alternative if it ever looks wrong with data in
  the columns.
- "New chat" became live in S1.7; "New agent" and "Add member" are still rendered `disabled`
  because they have nothing to do yet, which reads as dimmer than the mockup's
  accent. They light up in S2.1 and S2.2.
