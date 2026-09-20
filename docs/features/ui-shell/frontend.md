# ui-shell — Frontend

This feature is entirely frontend; see [backend.md](./backend.md) for the one
main-process fact it depends on.

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/App.tsx` | Composition root. Renders `AppShell` and nothing else (it used to hold the smoke screen) |
| `src/renderer/src/components/layout/app-shell.tsx` | The frame: `NavRail` plus the page named by the store. A `Record<Page, Component>` lookup, one page mounted at a time. Since S7.4 it is a column — rail and page in a `flex-1` row, `UpdateBar` under them — which changes nothing while the bar renders `null`, which is almost always |
| `src/renderer/src/components/layout/update-bar.tsx` | S7.4: the strip along the bottom offering "Restart to update", visible only in the `downloaded` state and only until the user waves it away |
| `src/renderer/src/components/layout/nav-rail.tsx` | 56px rail: the brand mark, Chats, Committees (S9.2), Agents, Settings pinned to the bottom. The window's drag handle |
| `src/renderer/src/components/layout/column.tsx` | One vertical strip: fixed width, one border, its own scroll context |
| `src/renderer/src/components/layout/page-header.tsx` | The 52px title bar; drag region, with `actions` opted back out |
| `src/renderer/src/components/layout/window-chrome.ts` | `TRAFFIC_LIGHT_INSET`, `DRAG_REGION`, `NO_DRAG` and why they exist |
| `src/renderer/src/components/ui/*` | `Button`, `IconButton`, `Input`, `TextArea`, `Select`, `Toggle`, `SegmentedControl`, `Badge`, `Chip`, `Avatar`, `PresenceDot`, `EmptyState`, `SectionTitle`, `Field`, `StatusPill`, `Spinner`, `BrandMark`, `ReorderableList`, `Dialog`, plus the `index.ts` barrel. S9.3 added `Dialog`, the shell's **first modal** — the scrim, a titled panel with a close button and an optional footer, `role="dialog"` + `aria-modal`, a focus trap that restores focus on close, Escape from a capturing document listener, and dismissal on a `mousedown` that started on the backdrop. It has no `open` prop: the caller renders it or does not, so "open" stays one fact in one store. Its scrim is a new token, `--color-overlay`, declared in both palettes and made opaque under `prefers-reduced-transparency`. S9.2 added `ReorderableList` — the member panel's native HTML5 drag-to-reorder, extracted so the committee editor reorders its members the same way; it is generic in the item, renders no container of its own (the caller's flex column and its `gap` lay the rows out) and takes no translated string, like every other primitive. S7.1 added `BrandMark` — the tile-less Aperture mark the rail shows, inlined as SVG so its blades can be `currentColor`. S2.5 added no primitive: the code block, the tool card and the mention popover are chat-specific and live under `components/chat/`. S5.10 added no primitive either, and widened one: a `SegmentedOption` may now be `disabled` on its own, so the chat Goal block can offer Document and Codebase while a chat has no folder to write into — disabled with the reason under them, rather than hidden |
| `src/renderer/src/pages/chats-page.tsx` | Chat list (264px) · conversation · member panel (288px), with the composer and the group-settings block |
| `src/renderer/src/pages/agents-page.tsx` | Agent list (264px) and the editor area's empty state |
| `src/renderer/src/pages/committees-page.tsx` | **S9.2**: committee list (264px) and the committee editor, deliberately the Agents page's layout down to the column width, the "+" and the two-step delete. See [`../committees/frontend.md`](../committees/frontend.md) |
| `src/renderer/src/pages/settings-page.tsx` | Section nav (220px) with the language quick toggle, and the content area |
| `src/renderer/src/pages/settings/about-section.tsx` | Settings → About (S7.5): the version, the repository link and the generated licence list. S7.4 added the **Updates** block directly under the version — one sentence for whatever state the backend is in, "Check for updates", and "Restart to update" once something is downloaded — which is also the first state and the first backend call this file has |
| `src/renderer/src/lib/updates.ts` | S7.4: `updateStateLabel`, `unsupportedLabel` and `canCheckForUpdates` — the status turned into one translated sentence and one boolean. Pure, unit-tested, and a `switch` of literal `t()` calls so the usage guard can see all eight keys |
| `src/renderer/src/stores/updates.ts` | S7.4: the mirror of `system.updateStatus`, the two event reducers, and `dismissedVersion` — the only piece of update state the backend does not own |
| `src/renderer/src/lib/licenses.ts` | The typed view of `generated/licenses.json` plus `licenseSummary()`, the per-licence counts About leads with. The only file that knows the generator's output shape |
| `src/renderer/src/pages/settings/appearance-section.tsx` | The appearance `SegmentedControl` (System / Light / Dark, S5.8) and the language `Select` |
| `src/renderer/src/pages/settings/theme.ts` | `applyThemeSetting` — the appearance control's counterpart to `language.ts` |
| `src/renderer/src/lib/theme.ts` | `applyTheme` / `activateTheme`: `data-theme` on `<html>`, plus the `matchMedia` subscription `'system'` needs |
| `src/renderer/src/lib/contrast.ts` | `parseHex`, `relativeLuminance`, `contrastRatio` and `rgbDistanceSquared` (S5.17). Pure WCAG arithmetic. `theme.test.ts` judges the palette with it and the matrix below is printed from it; only `agent-display.ts` imports it at runtime |
| `src/renderer/src/lib/hex-literals.test.ts` | Guard #3 (S5.17): no colour literal in the renderer outside `index.css`, the brand mark and the legacy avatar table |
| `src/renderer/src/components/agents/agent-display.ts` | `avatarStyle` / `avatarPalette` / `nearestAvatarPalette`: which of the eight monogram slots a record means, and the two `var(--color-avatar-…)` strings it is painted with. See [`../agents/frontend.md`](../agents/frontend.md) |
| `src/renderer/src/pages/settings/developer-section.tsx` | The transport smoke widgets, moved here from `App.tsx`, plus S5.7's Editor block ([`editor`](../editor/frontend.md)) — the one piece of real product settings on this screen, here because its custom mode is a shell command |
| `src/renderer/src/pages/settings/editor.ts` | `applyEditorSetting` — the Editor block's counterpart to `theme.ts` and `language.ts` (S5.7) |
| `src/renderer/src/pages/settings/language.ts` | `applyLanguageSetting` — the single handler both language controls call |
| `src/renderer/src/stores/ui.ts` | `page` and `settingsSection` plus their setters |
| `src/renderer/src/index.css` | Design tokens (dark base + the light override block), the `drag-region` / `no-drag` utilities and the two `.shiki` rules that pick a syntax theme |

Primitives never import `react-i18next`: they take already-translated strings.
That is what keeps an untranslated literal from hiding inside a shared component.

## State

| Store | Field | Type | Meaning |
|---|---|---|---|
| `ui` | `page` | `'chats' \| 'committees' \| 'agents' \| 'settings'` | Purely local. Which page the shell renders; starts on `chats`. `PAGES` is that union in **rail order** — S9.2 inserted `committees` between Chats and Agents, because a topic is convened from a committee and a committee is assembled from agents — and `ui.test.ts` pins it |
| `ui` | `settingsSection` | `'providers' \| 'mcp' \| 'skills' \| 'timeouts' \| 'appearance' \| 'data' \| 'about' \| 'developer'` | Purely local. Kept while another page is showing, so returning to Settings lands where the user left. `about` joined in S7.5, directly above `developer` |
| `settings` | `settings.language` | `Language \| 'system'` | Backend-owned (S1.4). Read by both language controls, written through `applyLanguageSetting` |
| `settings` | `settings.theme` | `'system' \| 'light' \| 'dark'` | Backend-owned (S5.8). Read by the appearance control, written through `applyThemeSetting`. The *painted* theme is not state at all — it is an attribute on `<html>` |
| `settings` | `error` | `string \| undefined` | Backend-owned. Rendered by the Developer section under `data-testid="error"` |
| `settings` | `settings.onboardingDismissed` | `boolean` | Backend-owned (S7.5). Written once, by the first-run card's Skip link; the shell only reads it through [`../chats/frontend.md`](../chats/frontend.md)'s `useOnboarding` |
| `updates` | `status` | `UpdateStatus` | Backend-owned (S7.4). Read by the Updates block and, through `updateReadyVersion`, by the notice bar |
| `updates` | `checking` | `boolean` | Purely local. True only while a check the *user* started is in flight, so the button can be disabled without the six-hourly one disabling it too |
| `updates` | `dismissedVersion` | `string \| null` | Purely local, and deliberately not persisted: a dismissal that survived a restart would hide an update the restart did not install |

Actions: `setPage(page)`, `setSettingsSection(section)`. Neither touches the
backend and neither persists — nothing about "which page was open" is worth a row
in SQLite, and a restart landing on Chats is the right default.

Since S10.3 the shell has **one caller of `setPage` that is not a click**:
`lib/event-bridge.ts`, on the `ui.open-chat` event a `witena://chat/<id>` link
produces. It navigates only when the chats store reports that it really selected
the chat, so a link to something this window does not have leaves the user on
the page they were on. That is the whole of the deep link's effect on this
feature; the event, the link and the launch behind them belong to
[`../mcp-endpoint/frontend.md`](../mcp-endpoint/frontend.md). `stores/ui.ts` is
unchanged — its header already reserved this: "if deep links ever matter … the
router becomes the thing that writes these two fields and nothing else has to
change", and one event bridge is a smaller version of exactly that.

Component-local state, deliberately not in a store:

- `ChatsPage` holds the group-settings values (`mode`, `speaking`,
  `maxAutoRounds`, `hardTimeoutMs`), seeded from `DEFAULT_CHAT_SETTINGS` and
  `DEFAULT_APP_SETTINGS`. S2.2 replaces it with the chat's own `ChatSettings`.
- `DeveloperSection` holds `ping`, `lastEvent` and its own `error`.

## Backend calls

| Call / subscription | Called from | Purpose |
|---|---|---|
| `invoke('settings.update', { patch: { language } })` | `applyLanguageSetting`, via `useSettingsStore.setLanguage` | Persist the language chosen in either control |
| `invoke('settings.update', { patch: { theme } })` | `applyThemeSetting`, via `useSettingsStore.setTheme` | Persist the appearance (S5.8) |
| `invoke('system.applyTheme', { theme })` | The same action, after the write | Tints the window chrome the renderer cannot paint. Its failure is swallowed: a server build rejects it and the page is still correct |
| `invoke('system.updateStatus')` | `useUpdatesStore.load()`, from the bootstrap in `main.tsx` and again when the Updates block mounts (S7.4) | The cached status. It never rejects out of the store: a transport with no such method is a build without updates, which `idle` already says |
| `invoke('system.checkForUpdates')` | "Check for updates" | Asks the feed now. The button is disabled while a check or a download is running, because a second click would join the first anyway |
| `invoke('system.installUpdate')` | "Restart to update", in the bar and in About | Quits and relaunches into the downloaded version |
| `invoke('system.ping')` | `DeveloperSection` on mount | Request/response, end to end |
| `invoke('system.emitTestEvent', { payload })` | The Developer section's button | The push direction |
| `subscribe(…)` filtered to `system.test` | `DeveloperSection` effect | Renders the last payload received; unsubscribes on cleanup (StrictMode runs effects twice in development) |

`settings.get` is still called once by the bootstrap in `main.tsx`, before the
shell mounts, and since S7.4 `system.updateStatus` is called there too — not
awaited, because no frame depends on it. No page calls the client directly except
the Developer section, which is a deliberate test surface rather than product UI;
the Updates block goes through `stores/updates.ts` like every other screen.

## Interaction states

| State | What the user sees |
|---|---|
| idle | The rail highlights the current page (`aria-current="page"`); the settings nav highlights the current section; the language toggle highlights the stored setting with `aria-pressed` |
| loading | None. The bootstrap resolves settings, the language **and the theme** before the React root is created, so the first frame is already correct — and the window itself was created in that theme's `backgroundColor` (S5.8), so a light-theme launch never flashes dark |
| streaming | Shipped in S1.7, see [`../chats/frontend.md`](../chats/frontend.md): the reply grows with a cursor and Send becomes Stop |
| empty | This is the shell's normal state in S1.5: an `EmptyState` (icon, title, description) for no chats, no conversation, no members, no agents, no agent selected, and for each settings section that its own step has yet to build |
| update ready | A strip along the bottom of the window: "Version 0.2.0 is ready to install.", **Restart to update**, and a close button. It is the only persistent chrome the shell grows, and it exists for at most one restart (S7.4) |
| error | `settings.get` failing leaves the language at the system default and shows the detail in Settings → Developer under `data-testid="error"`; the app still starts. A failed `settings.update` is written into the same field by `applyLanguageSetting`, and the optimistic highlight is corrected by the next successful read |

## Copy and i18n

Keys added, by namespace:

| Namespace | Keys |
|---|---|
| `nav` | `primary` (the rail's accessible name) |
| `chat` | `noChatSelected`, `emptyChatsTitle`, `emptyChatsDescription`, `emptyConversationTitle`, `emptyConversationDescription`, `emptyMembersTitle`, `emptyMembersDescription`, `mode`, `modeRoundrobin`, `modeMentionOnly`, `speaking`, `speakingSequential`, `speakingParallel`, `maxAutoRounds`, `maxRoundsShort`, `timeout`, `secondsValue`, `speakingOrder`, `speakingOrderHint`, `actions.*` (S2.5 turned the flat `actions` / `actionSummarize` / `actionVote` into the nested `actions.title` / `.summarize` / `.vote` plus the two prompts the buttons send), `mentionHint` |
| `agents` | `emptyTitle`, `selectOrCreateTitle`, `selectOrCreateDescription` (and `empty` reworded into a description, since it now sits under a title) |
| `settings` | `sections.about` and the `about.*` subtree — `version`, `versionHint`, `repository`, `repositoryHint`, `licenses`, `licensesHint` (`{{packages}}`) — all added in S7.5, plus S7.4's `about.updates.*`: `title`, `check`, `restart`, one sentence per update state (`idle`, `checking`, `available`, `downloading`, `downloaded`, `upToDate`, `error`), `unsignedBuild` and `developmentBuild` for the two reasons a build cannot update itself, `hint`, and the bar's own `barTitle` / `barDismiss`. The interpolations are `{{version}}`, `{{percent}}` and `{{message}}` — the last of which is the updater's own words, not a key, because there is no fixed set of network failures to translate; `theme`, `themeSystem`, `themeLight`, `themeDark`, `themeHint` (S5.8), `sections.developer`, `comingSoonTitle`, `comingSoonDescription`, `interfaceLanguage`, `languageHint`, `languageSystemShort`, `languageZhShort`, `languageEnShort`, and the `developer.*` subtree (`backend`, `languageSetting`, `resolvedLanguage`, `lastEvent`, `emitTestEvent`, `pending`, `noEvent`) |

Removed: the whole `smoke` namespace. Its strings are the `settings.developer.*`
subtree now, and `EXPECTED_NAMESPACES` in `locales.test.ts` was updated to match —
which is the deliberate decision that constant's comment asks for.

Two traps worth repeating, both hit while writing this feature:

1. **Do not name an interpolation placeholder `count`.** i18next treats `count`
   as the plural trigger and looks for `key_one` / `key_other`; the badge rendered
   a literal `{{rounds}}` until the parameter was renamed. Placeholders here are
   `{{rounds}}` and `{{seconds}}`.
2. **Keys must be literal.** `t(KEYS[section])` compiles and ships a missing key;
   `used-keys.test.ts` cannot see it. Every label goes through a `switch` of
   literal `t()` calls, which also makes the compiler prove the mapping is total.

The shell now has **no** untranslated text at all. Until S7.1 the one exception
was the `W` of the placeholder app mark, which survived only because a single
letter is below the guard's three-letter threshold. `BrandMark` is a drawing
rather than a glyph, so there is nothing left to exempt and `ALLOWED_JSX_TEXT` is
still empty, as intended.

## The palette

### Colour is a token, and only a token

Every colour in the app is a `--color-*` in `index.css`, and the light theme is
that file's second block. Three files are allowed a literal and no others; a
fourth is a test failure, not a review comment:

| File | Why it may hold a hex |
|---|---|
| `src/renderer/src/index.css` | It *is* the palette |
| `components/ui/brand-mark.tsx` | `--color-brand-point` is an identity and `build/icon.svg` repeats it, because an SVG on disk cannot read a CSS variable (S7.1) |
| `components/agents/agent-display.ts` | `LEGACY_AVATAR_COLORS`: the eight amber-era hexes every pre-S5.17 agent record carries, kept as the table a stored colour is resolved through (S5.17) |

`lib/hex-literals.test.ts` greps the renderer for `#rgb`, `#rrggbb` and
`#rrggbbaa` outside those files, with comments blanked out so a colour *named in
prose* (`highlighter.ts` explains its shiki theme by quoting that theme's
background) is not a violation. Test files are not scanned: a fixture is allowed
to name the colour a record used to hold.

### The monogram palette (S5.17)

Eight background / foreground pairs, `--color-avatar-1-bg` / `-fg` through
`-8-`, plus `--color-avatar-neutral-*` and the human's own
`--color-avatar-user` / `-fg`. Both palettes define all twenty.

A tile names a **slot**, never a colour. `InitialAvatar.palette` is the small
integer an agent stores; `avatarStyle` in `components/agents/agent-display.ts`
turns it into the two `var(--color-avatar-N-…)` strings the `Avatar` primitive
puts in an inline style, and a record written before the index existed is
resolved through `nearestAvatarPalette` **as it is drawn** — no migration, no
write on read, nothing half-converted if the app is killed mid-upgrade.
`providerLogo` returns the same shape, so a provider tile and an agent tile are
the same eight colours.

### Contrast

Computed by `lib/contrast.ts` from the token values, and asserted by
`lib/theme.test.ts`: the body-copy steps (`fg`, `fg-secondary`, `fg-muted`) plus
`accent` and `danger` are AA-normal (4.5:1) on **every** surface token, and the
small print (`fg-dim`, `fg-faint`) is at least 3:1 on every one. Regenerate this
table from `index.css` rather than editing a number in it.

#### Dark

| | `bg-base` | `bg-panel` | `bg-rail` | `bg-elevated` | `bg-hover` | `bg-muted` |
|---|---|---|---|---|---|---|
| `fg` | 14.00 | 13.60 | 14.60 | 13.33 | 11.38 | 11.98 |
| `fg-secondary` | 11.89 | 11.56 | 12.41 | 11.33 | 9.67 | 10.18 |
| `fg-muted` | 8.76 | 8.51 | 9.14 | 8.34 | 7.12 | 7.50 |
| `fg-dim` | 5.78 | 5.61 | 6.03 | 5.50 | 4.70 | 4.94 |
| `fg-faint` | 4.07 | 3.95 | 4.24 | 3.87 | 3.30 | 3.48 |
| `accent` | 5.79 | 5.63 | 6.04 | 5.52 | 4.71 | 4.96 |
| `accent-hover` | 7.45 | 7.24 | 7.77 | 7.10 | 6.06 | 6.38 |
| `danger` | 7.04 | 6.84 | 7.34 | 6.70 | 5.72 | 6.02 |

#### Light

| | `bg-base` | `bg-panel` | `bg-rail` | `bg-elevated` | `bg-hover` | `bg-muted` |
|---|---|---|---|---|---|---|
| `fg` | 15.33 | 16.56 | 14.03 | 16.81 | 12.82 | 13.79 |
| `fg-secondary` | 12.11 | 13.08 | 11.09 | 13.28 | 10.13 | 10.89 |
| `fg-muted` | 8.27 | 8.94 | 7.57 | 9.07 | 6.92 | 7.44 |
| `fg-dim` | 5.74 | 6.21 | 5.26 | 6.30 | 4.80 | 5.17 |
| `fg-faint` | 4.55 | 4.91 | 4.16 | 4.99 | 3.80 | 4.09 |
| `accent` | 6.15 | 6.64 | 5.63 | 6.75 | 5.14 | 5.53 |
| `accent-hover` | 8.20 | 8.87 | 7.51 | 9.00 | 6.86 | 7.38 |
| `danger` | 5.86 | 6.33 | 5.36 | 6.43 | 4.90 | 5.27 |

S5.17 moved four of these values. `fg-dim` and `fg-faint` were `#8a857b` /
`#6f6a62` in dark and `#6b655a` / `#7d776b` in light: on `bg-hover` they measured
4.00:1 and **2.74:1** (dark) and 4.41:1 and 3.39:1 (light), so hovering a row
took its own timestamps and hints below the floor. `--color-status-idle` moved
with `fg-dim` (4.22:1 on its own surface), and the light `--color-danger` went
from `#b23b3b` to `#a93636` because 4.47:1 on `bg-hover` was a hovered row's
delete button sitting just under AA.

#### Monogram on its own tile

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | neutral | user |
|---|---|---|---|---|---|---|---|---|---|---|
| dark | 6.63 | 6.62 | 6.27 | 6.77 | 6.54 | 6.36 | 6.63 | 6.25 | 7.34 | 6.48 |
| light | 5.35 | 6.58 | 7.19 | 6.19 | 6.49 | 5.75 | 5.73 | 7.18 | 6.72 | 6.59 |

A monogram is bold but 10–13px, so it is held to AA-normal rather than AA-large.

#### Everything else

| | Status pills, on their own surface | Presence dots, on `bg-panel` | `border` / `border-strong` on `bg-base` |
|---|---|---|---|
| dark | ok 6.95, warn 6.06, idle 4.94 | available 7.71, working 4.90, away 7.76, offline 3.95 | 1.17 / 1.30 |
| light | ok 5.06, warn 4.90, idle 5.30 | available 3.31, working 4.53, away 3.79, offline 3.61 | 1.24 / 1.49 |

A presence dot is not text; 3:1 is the non-text floor and the right bar for it. A
border is a hairline between two surfaces of the same family and is deliberately
quiet — which is what `prefers-contrast` is for.

### Accessibility preferences (S5.17)

Two media queries at the bottom of `index.css`, each written **twice** — once for
`:root` and once for `:root[data-theme='light']`, because the light selector
outranks a bare `:root` however late it appears.

`prefers-contrast: more` raises only the steps that are allowed to be quiet, and
only as far as they need:

| | `fg-muted` | `fg-dim` | `fg-faint` | `border` | `border-strong` |
|---|---|---|---|---|---|
| dark | 7.12 → 9.00 | 4.70 → 6.65 | 3.30 → 5.32 | 1.00 → 1.59 | 1.05 → 2.14 |
| light | 6.92 → 9.85 | 4.80 → 7.82 | 3.80 → 6.69 | 1.04 → 1.71 | 1.25 → 2.44 |

(worst case across the six surfaces). `fg`, `fg-secondary` and every hue that
carries *meaning* — the accent, the presence states, the status tones, the eight
avatar slots — are deliberately untouched: they are already 4.5:1 or better
everywhere, and shifting a hue to gain contrast it does not need would only make
the two appearances disagree about what green means.

`prefers-reduced-transparency: reduce` has exactly one surface to answer for.
`--color-bg-subtle` is `bg-hover` at 60% — the tint a pointer leaves on a row
whose *selected* state is the full `bg-hover` — and the query replaces it with
the colour that alpha composites to over `bg-panel`. It used to be six copies of
`hover:bg-bg-hover/50` and `/60` written into six components, which is why no
stylesheet could answer for it before. `theme.test.ts` asserts it is the **only**
token with an alpha channel, so a second one cannot appear without the query
growing to match.

Element `opacity` is not touched. A disabled control and a superseded message are
*states*; the preference is about see-through materials, not about the interface
hiding what it means. The one place that composites text is a passed or skipped
message row, and S5.17 raised it from `opacity-50` to `opacity-70`: at half
strength its name measured 3.26:1 in light and its model line 2.17:1, under the
floor in both appearances.

## Accessibility and keyboard

- Every icon-only control has a translated accessible name: `IconButton` requires
  `label` and sets both `aria-label` and `title`; every decorative lucide icon is
  `aria-hidden`.
- `BrandMark` is `aria-hidden` with `focusable="false"`. The rail is already
  labelled and the product name is in the window title; announcing "Witena" ahead
  of every navigation would be noise, so the mark contributes no accessible name
  and therefore no locale key.
- The rail marks the current destination with `aria-current="page"`, the settings
  nav does the same, and both segmented controls use `aria-pressed`.
- `Toggle` is `role="switch"` with `aria-checked`, not a repainted checkbox.
- `Select` is a real `<select>`, so the popup keeps the platform's keyboard
  navigation, type-ahead and VoiceOver behaviour.
- `SectionTitle` renders `h2` / `h3`, and `PageHeader` renders the content area's
  `h1`, so the shell has a usable document outline.
- Focus is visible everywhere: `focus-visible:ring-1 focus-visible:ring-accent`
  on every interactive element.
- Tab order follows the DOM: rail → column header → column body → next column.
  The one focus trap in the app is `Dialog`'s (S9.3), which is what a modal is:
  focus moves inside on open, Tab and Shift+Tab cycle within the panel, Escape
  dismisses, and focus returns to whatever held it before — without the last
  part, closing a dialog would drop focus on `<body>` and the next Tab would
  start at the top of the window. (S1.7 added the composer's own Enter /
  Shift+Enter handling; the shell itself still has none.) Enter/Shift+Enter in
  the composer is S2.5.

### Opening an external link

Settings → About is the shell's first real hyperlink. Two halves, and both are
needed:

- the anchor carries `target="_blank" rel="noreferrer"`, which makes the click a
  *window-open request* rather than an in-place navigation — an in-place one
  would replace the whole application with a web page and there is no back
  button to return from it;
- `setWindowOpenHandler` in `src/main/index.ts` denies every such request and
  hands http(s) to `shell.openExternal` first. It was installed for links inside
  a message body and needed no change here.

A relative or `file:` URL would therefore do nothing at all, which is the
intended answer: only the two constants in `@shared/version` reach this anchor.

### Window chrome

The window uses `titleBarStyle: 'hiddenInset'`, which has two consequences the
layout has to carry:

- **The traffic lights overlap the content**, roughly x 13–70, y 6–26. The rail
  and the leftmost column header therefore start at `TRAFFIC_LIGHT_INSET` (32px)
  rather than the mockup's 14px. The member panel and the settings content do
  *not* get the inset — the lights are nowhere near them. This is the one
  knowing, visible difference from the artboards.
- **The window has no handle unless the app provides one.** The rail and every
  `PageHeader` carry `drag-region`; every button, input and select inside them
  carries `no-drag`. Forgetting the second half makes a control silently
  unclickable, which is why the pair lives in one small module with that warning
  in its header.
