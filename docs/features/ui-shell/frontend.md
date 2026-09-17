# ui-shell — Frontend

This feature is entirely frontend; see [backend.md](./backend.md) for the one
main-process fact it depends on.

## Pages and components

| File | Responsibility |
|---|---|
| `src/renderer/src/App.tsx` | Composition root. Renders `AppShell` and nothing else (it used to hold the smoke screen) |
| `src/renderer/src/components/layout/app-shell.tsx` | The frame: `NavRail` plus the page named by the store. A `Record<Page, Component>` lookup, one page mounted at a time. Since S7.4 it is a column — rail and page in a `flex-1` row, `UpdateBar` under them — which changes nothing while the bar renders `null`, which is almost always |
| `src/renderer/src/components/layout/update-bar.tsx` | S7.4: the strip along the bottom offering "Restart to update", visible only in the `downloaded` state and only until the user waves it away |
| `src/renderer/src/components/layout/nav-rail.tsx` | 56px rail: the brand mark, Chats, Agents, Settings pinned to the bottom. The window's drag handle |
| `src/renderer/src/components/layout/column.tsx` | One vertical strip: fixed width, one border, its own scroll context |
| `src/renderer/src/components/layout/page-header.tsx` | The 52px title bar; drag region, with `actions` opted back out |
| `src/renderer/src/components/layout/window-chrome.ts` | `TRAFFIC_LIGHT_INSET`, `DRAG_REGION`, `NO_DRAG` and why they exist |
| `src/renderer/src/components/ui/*` | `Button`, `IconButton`, `Input`, `TextArea`, `Select`, `Toggle`, `SegmentedControl`, `Badge`, `Chip`, `Avatar`, `PresenceDot`, `EmptyState`, `SectionTitle`, `Field`, `StatusPill`, `Spinner`, `BrandMark`, plus the `index.ts` barrel. S7.1 added `BrandMark` — the tile-less Aperture mark the rail shows, inlined as SVG so its blades can be `currentColor`. S2.5 added no primitive: the code block, the tool card and the mention popover are chat-specific and live under `components/chat/`. S5.10 added no primitive either, and widened one: a `SegmentedOption` may now be `disabled` on its own, so the chat Goal block can offer Document and Codebase while a chat has no folder to write into — disabled with the reason under them, rather than hidden |
| `src/renderer/src/pages/chats-page.tsx` | Chat list (264px) · conversation · member panel (288px), with the composer and the group-settings block |
| `src/renderer/src/pages/agents-page.tsx` | Agent list (264px) and the editor area's empty state |
| `src/renderer/src/pages/settings-page.tsx` | Section nav (220px) with the language quick toggle, and the content area |
| `src/renderer/src/pages/settings/about-section.tsx` | Settings → About (S7.5): the version, the repository link and the generated licence list. S7.4 added the **Updates** block directly under the version — one sentence for whatever state the backend is in, "Check for updates", and "Restart to update" once something is downloaded — which is also the first state and the first backend call this file has |
| `src/renderer/src/lib/updates.ts` | S7.4: `updateStateLabel`, `unsupportedLabel` and `canCheckForUpdates` — the status turned into one translated sentence and one boolean. Pure, unit-tested, and a `switch` of literal `t()` calls so the usage guard can see all eight keys |
| `src/renderer/src/stores/updates.ts` | S7.4: the mirror of `system.updateStatus`, the two event reducers, and `dismissedVersion` — the only piece of update state the backend does not own |
| `src/renderer/src/lib/licenses.ts` | The typed view of `generated/licenses.json` plus `licenseSummary()`, the per-licence counts About leads with. The only file that knows the generator's output shape |
| `src/renderer/src/pages/settings/appearance-section.tsx` | The appearance `SegmentedControl` (System / Light / Dark, S5.8) and the language `Select` |
| `src/renderer/src/pages/settings/theme.ts` | `applyThemeSetting` — the appearance control's counterpart to `language.ts` |
| `src/renderer/src/lib/theme.ts` | `applyTheme` / `activateTheme`: `data-theme` on `<html>`, plus the `matchMedia` subscription `'system'` needs |
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
| `ui` | `page` | `'chats' \| 'agents' \| 'settings'` | Purely local. Which page the shell renders; starts on `chats` |
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
  No focus traps. (S1.7 added the composer's own Enter / Shift+Enter handling; the
  shell itself still has none.) Enter/Shift+Enter in the composer is
  S2.5.

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
