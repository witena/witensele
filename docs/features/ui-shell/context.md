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
- The pages as static shells: `ChatsPage` (list / conversation / member
  panel), `AgentsPage` (list / editor), `SettingsPage` (section nav / content),
  and since S9.2 `CommitteesPage` (list / editor), owned by
  [`committees`](../committees/context.md) and routed here.
- The primitives under `components/ui/` and the layout helpers under
  `components/layout/`.
- **The two palettes and the appearance setting (S5.8).** The dark tokens
  from the mockup are the base; a light palette overrides all of them under
  `:root[data-theme='light']`, and `lib/theme.ts` decides which one is
  stamped. The three-segment control in Appearance & language, the window's
  first-frame colour and the title-bar traffic lights are the same setting
  seen from three places.
- **The monogram palette and the accessibility preferences (S5.17).** Eight
  indexed background / foreground pairs, plus a neutral one, that every avatar
  and every provider tile is painted from — the last two things in the app that
  held a colour of their own — and the `prefers-contrast` /
  `prefers-reduced-transparency` blocks that answer for the palette when the
  machine asks for something stronger or flatter. The contrast of every step on
  every surface is arithmetic the suite runs (`lib/contrast.ts`) rather than a
  claim, and the matrix is printed in [frontend.md](./frontend.md).
- The language switch, which is the one piece of real behaviour on the page: the
  quick toggle at the bottom of the settings nav and the select in Appearance &
  language, both writing the setting S1.4 already persists.
- Settings → Developer, the new home of the transport smoke widgets the
  end-to-end specs drive.
- **Settings → About (S7.5)**: the version, the repository link and the
  licences of every bundled dependency. It is the shell's section because
  nothing else owns it — it describes the application itself rather than a
  feature — and because the settings navigation it joins is this feature's.
- **The Updates block and the notice bar (S7.4)**, for the same reason. The
  block sits directly under the version, which is the question it answers, and
  the bar is a strip along the **bottom** of `AppShell` offering "Restart to
  update" once something has been downloaded. The mechanism behind them —
  `electron-updater`, the state machine, the feed — belongs to
  [`../packaging/context.md`](../packaging/context.md) and
  [`../backend-client/context.md`](../backend-client/context.md); what this
  feature owns is `stores/updates.ts`, `lib/updates.ts` and the two surfaces.

## Out of scope

| Deliberately absent | Owned by |
|---|---|
| Chat list, messages, composer behaviour, streaming | S1.7 (`chats`, `agent-turn`) |
| Provider cards, the add/edit panel, model chips | S1.6 (`providers`) |
| The agent configuration form | S2.1 (`agents`) |
| Member add / remove / reorder, persisting chat settings | S2.2 (`chats`) |
| Message rendering, tool cards, `@` autocomplete | S2.5 |
| Live presence dots | S2.4 (`presence`) — the `PresenceDot` component exists, nothing feeds it yet |
| The Data & backup settings section | S4.x — it renders an empty state naming the step. Providers (S1.6), MCP servers (S3.1), Skills (S3.2), Appearance & language (S1.5), Timeouts & heartbeat (S2.4), About (S7.5) and Developer have content |
| The first-run card itself | S7.5, split between [`../chats/context.md`](../chats/context.md) (it is drawn in the conversation column, in place of this feature's empty state) and [`../providers/context.md`](../providers/context.md) (the controls it drives). The shell's part is one line: the column asks whether the card is visible and renders the `EmptyState` only when it is not |
| ~~"Check for updates" in About~~ | **Shipped in S7.4.** The block shows the state, the version being offered and the button; an unsigned build or a checkout shows why there is nothing to check instead |
| ~~A light theme~~ | **Shipped in S5.8**, and it was the swap this row predicted: one override block in `index.css` plus `data-theme` on `<html>`. No component changed |

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
| One attribute on `<html>` switches the theme (S5.8) | A React context with a `theme` value; a `dark:` variant on every utility; two stylesheets | A utility already compiles to `var(--color-…)`, so redefining the variables repaints everything that is mounted, everything that is not, and everything a later step adds. A context would have to be consumed to matter, and `dark:` doubles every class in the app |
| The light palette keeps each dark step's contrast, and *darkens* the accent (S5.8) | Invert the lightness of every token; keep the accent as drawn | Inversion puts the rail above the panels and turns a pale accent into body text on white. Roles, not lightness, are what the palette encodes |
| The interface accent **is** the brand colour (S7.1) | Keep the amber `#d8a656` beside a terracotta mark; pick a third colour that harmonises with both | Two warm colours a hue apart do not read as a palette, they read as a mistake. The mark's terracotta `#d97757` is the accent in the dark palette unchanged (5.79:1 on `bg-base`) and darkened to `#a13917` in the light one (6.15:1), so every accent surface in the app is the same colour as the icon in the Dock |
| `--color-brand-point` is the same value in both palettes | Give it a light override like every other token; hard-code the terracotta in the component | It is an **identity**, not a role: a mark whose colour shifted with the appearance would be two marks. It is still declared in both blocks so `theme.test.ts` keeps watching it, and `CONSTANT_TOKENS` in that file is the named, deliberately tiny exception to "every override differs" |
| The rail mark is an inlined SVG with `currentColor` blades | Two PNG assets; one SVG per theme; an `<img>` pointing at `build/icon.svg` | `currentColor` is what makes one drawing work in both palettes, which is the same argument S5.8 makes for the whole theme. An `<img>` cannot inherit a colour, and two assets is two things to keep in step with the icon |
| `'system'` is stored as itself and resolved at use (S5.8) | Resolve once and store `light` / `dark` | Exactly the language decision from S1.4. A machine that flips at sunset should take the app with it |
| ~~Avatar and provider-logo colours stay dark in both themes (S5.8)~~ **Reversed in S5.17: a tile stores a palette *index* and the stylesheet holds the colours** | Keep them dark; migrate every stored row to new hexes; keep two palettes and branch on `data-theme` in the component | The premise was wrong, not the reasoning: the *choice* is data, the colour is not. `InitialAvatar.palette` is a small integer, so the stylesheet can give slot 3 a deep violet in dark and a pale one in light and no record has to change. A migration was the alternative and it is the bad one — it rewrites rows for a cosmetic reason, it can half-fail, and it makes a downgrade render wrong; mapping a stored hex to its slot **at render time** costs one pure function and cannot fail at all |
| The eight legacy hexes stay in `agent-display.ts` as a named table (S5.17) | Delete them and default an index-less record to neutral; move them into a database migration | Deleting them would repaint every agent written before this step as grey — the one outcome the no-migration design exists to avoid. As a table they do two jobs: they resolve an old record, and they are the compatibility shadow a *new* record still writes into `avatar.color` for any consumer that has never heard of `palette`. It is the one file besides `index.css` and the brand mark where `hex-literals.test.ts` allows a colour |
| Provider tiles reuse the agent palette rather than keeping a list of their own (S5.17) | Give providers their own eight theme-aware pairs | Two eight-entry lists that were copies of each other had already drifted in two slots. One list is one thing to tune, and the hash that assigns a preset to a slot is unchanged, so a provider keeps its swatch number |
| `prefers-contrast` and `prefers-reduced-transparency` are written **twice**, once per appearance (S5.17) | One unqualified `:root` block | `:root[data-theme='light']` has higher specificity than `:root` whatever the source order, so a single block would strengthen the dark theme and silently do nothing in the light one. `theme.test.ts` asserts both halves name the same tokens |
| `drag-region` / `no-drag` as `@utility` in `index.css` | Tailwind arbitrary properties `[-webkit-app-region:drag]`, inline styles | The leading `-` of the vendor prefix collides with Tailwind's negative-value syntax, and `WebkitAppRegion` is not in React's `CSSProperties` |
| The licence list is generated at build time, gitignored, and imported as JSON (S7.5) | A hand-maintained Markdown list; a runtime scan of `node_modules`; committing the generated file | The list is derived from the installed tree, so a hand-written copy is wrong the first time a dependency moves and **nothing fails** — a stale licence list looks exactly like a correct one. A packaged app has no `node_modules` to scan at runtime. Committing it would mean reviewing a 244-entry diff on every `npm update`, so it is produced by `pretypecheck` / `pretest` / `prebuild` instead and ignored by git |
| About prints the version, the package names and the repository URL as data, never through `t()` (S7.5) | Translate "Witena {{version}}" | Every label around them *is* translated; the values are identifiers. `0.1.0`, `react@19.3.0` and a URL are the same in both languages, and a placeholder would only add a way for them to differ |
| The repository is a real `target="_blank"` link | Print the URL as selectable text, like the `ant` install command | A URL is meant to be followed, and the shell already has the machinery: `setWindowOpenHandler` in `src/main/index.ts` hands http(s) to the system browser and denies everything else, which is the same path a link inside a message body takes. The URL is printed *as* the link text, so it can still be read or copied |
| The smoke widgets moved to Settings → Developer rather than deleted | Delete them; keep a hidden debug route | `smoke.spec.ts` and `i18n.spec.ts` are the only end-to-end proof the transport works, and nothing else is observable until S1.7. A visible settings section is cheaper than a hidden one and survives being forgotten |
| `smoke.*` strings moved under `settings.developer.*` | Keep the `smoke` namespace | The namespace belonged to a screen that no longer exists. `locales.test.ts`'s `EXPECTED_NAMESPACES` was updated with it, which is the deliberate decision its comment asks for |
| Group settings are live local state, not disabled controls | Render them `disabled` | A page of dead controls is hard to judge against the mockup. Local state shows the real interaction and is obviously temporary |
| **S7.4: the notice bar is along the bottom of the window** | A banner across the top, above the rail and the page; a toast in a corner; a badge on the Settings rail icon | `titleBarStyle: 'hiddenInset'` leaves the traffic lights floating over the top-left of the *content*, so a full-width top bar either sits under them or needs the same inset every draggable header already carries — a cost paid for a strip that is visible for one restart in a user's whole month. The bottom edge belongs to nobody. A toast implies "this will go away"; this offer should not. A badge on the rail is a nudge rather than an offer, and the offer is one click |
| **S7.4: the bar is dismissable per version, in the renderer** | Not dismissable; a settings row like `onboardingDismissed`; one boolean | "Not now" has to mean something or the strip is nagging, and it has to stop meaning it when a *newer* version arrives — hence per version, not a boolean. It stays in the store rather than the database because it is a fact about this window: a dismissal that survived a restart would hide an update the restart did not install, since Electron installs the pending update on quit either way |
| **S7.4: About re-reads the status on mount** | Trust the bootstrap read and the two events | The events carry `available` and `downloaded` and nothing else — there is deliberately no progress or error event — so a window that has been open for hours has a status that is right about what the user can do and possibly stale about the rest. `system.updateStatus` is a cached read with no network behind it, so the mount costs one IPC round trip |
| The leftmost column headers sit 32px from the top, not 14px | Keep the mockup's 14px; use a custom title bar | macOS draws the traffic lights over the top-left of the content. The mockup has no window chrome to design around; something had to give (see [frontend.md](./frontend.md)) |

## Open questions

- ~~The light theme has not been seen on the screens that only exist while a
  run is in progress.~~ **Closed by S5.17**, which photographs every screen with
  content on it in both appearances (`e2e/theme-review.spec.ts`). It found four
  things: the message-list avatars were the last component still painting from a
  stored hex, a passed or skipped row was drawn at 50% opacity and measured
  3.26:1 in light, `fg-dim` and `fg-faint` were under their bars on `bg-hover`,
  and five components carried `/50` and `/60` alpha utilities that no stylesheet
  could answer for. All four are fixed; the per-screen list is in S5.17's
  `Done:` paragraph.
- **Nothing measures a *rendered* pixel.** The contrast matrix is computed from
  the token values, so it is exact for text on a plain surface and says nothing
  about text over an `opacity` — which is how the dimmed-row defect survived
  from S2.x to S5.17. The two places the app still composites (`opacity-70` on a
  passed row, `opacity-45` on a disabled control) were checked by hand this
  time; a guard would need a real browser and a colour sampler.
- **A streaming message and a live presence sweep are still only seen with a
  model attached.** The review seeds a finished transcript, so the blinking
  accent cursor and the four presence colours changing under one another are the
  two states it cannot reach. `e2e/presence.spec.ts` covers them with Ollama.

- The 32px traffic-light inset makes the leftmost column header sit lower than
  the 52px page header next to it. It is defensible (Slack and Discord do the
  same) but it is a real difference from the artboards; a custom title bar strip
  spanning the full width is the alternative if it ever looks wrong with data in
  the columns.
- The mark reads as a solid ring rather than as six blades below about 20 px.
  The rail renders it at 28 px, where the blades separate cleanly, and the
  application icon's 16 px variant is drawn with a thickened stroke for exactly
  this reason (see [`../packaging/backend.md`](../packaging/backend.md)). Nothing
  in the app renders it smaller than 28 px today; a favicon or a menu-bar item
  would be the first thing that does, and is recorded under "Appearance" in Phase
  6 of STEPS.md.
- "New chat" became live in S1.7; "New agent" and "Add member" are still rendered `disabled`
  because they have nothing to do yet, which reads as dimmer than the mockup's
  accent. They light up in S2.1 and S2.2.
