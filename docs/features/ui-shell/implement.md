# ui-shell — Implementation

## Approach

Three layers, bottom up.

**Tokens.** `src/renderer/src/index.css` declares every colour, the two font
stacks and (new in S1.5) the `drag-region` / `no-drag` utilities inside
`@theme static` / `@utility`. No component contains a literal colour; the one
exception is *data* — an agent's `avatar.color` — which arrives as an inline
style because Tailwind cannot see a value that only exists at runtime.

Since S5.8 that block is the **dark** palette and `:root[data-theme='light']`
overrides every `--color-*` token in it, with `color-scheme` set on both roots
so scrollbars, selection and the native `<select>` follow. A utility compiles
to `var(--color-…)`, so the attribute on `<html>` is the entire switch: nothing
re-renders, no component reads the theme, and a screen written in a later step
is themed the day it is written. The rule this creates: **a token added to
`@theme static` must be added to the light block as well**, and
`lib/theme.test.ts` fails when it is not.

**Primitives.** `components/ui/` holds the vocabulary: `Button`, `IconButton`,
`Input`, `TextArea`, `Select`, `Toggle`, `SegmentedControl`, `Badge`, `Avatar`,
`PresenceDot`, `EmptyState`, `SectionTitle`, `Field`. They are presentational and
stateless — every one takes already-translated strings, so no primitive imports
`react-i18next` and none of them can leak an untranslated literal.
`SegmentedControl`'s options carry an optional per-option `disabled` since S5.10,
on top of the control's own: the chat Goal block needs two of its three segments
disabled while the chat has no folder, and a segment that disappeared would
teach nobody that the kind exists.
`components/layout/` holds `Column` (fixed width, one border, its own scroll
context), `PageHeader` (the 52px bar) and `window-chrome.ts` (the constants for
living under a hidden title bar).

**Shell and pages.** `App.tsx` is a composition root and nothing else; it renders
`AppShell`, which renders `NavRail` plus the page named by `stores/ui.ts`. The
three pages sit in `pages/`, with every settings section that has content in
`pages/settings/` (providers, appearance, timeouts, developer).

Two conventions that are worth knowing before adding a screen:

- **Labels come from literal `t()` calls, resolved by a `switch`.** `navLabel`,
  `sectionLabel`, `modeLabel` and `speakingLabel` all look redundant next to a
  `Record<Key, string>` lookup. They exist because `t(KEYS[k])` is invisible to
  `i18n/used-keys.test.ts` — the guard says so in its own header — and because
  the compiler then proves the mapping is total.
- **Never put two JSX elements in adjacent `switch` arms.** The same guard reads
  `return <A />` / `case 'b':` / `return <B />` as a hard-coded text node between
  two tags. `AppShell` uses a `Record<Page, Component>` for exactly this reason.

## Data flow

The appearance setting, the shell's second backend path (S5.8):

```
click a segment of System / Light / Dark
  → applyThemeSetting(setting)               pages/settings/theme.ts
  → useSettingsStore.setTheme(setting)       optimistic local write
  → activateTheme(setting)                   lib/theme.ts: data-theme on <html>
                                             (+ a matchMedia subscription for 'system')
  → BackendClient.invoke('settings.update')  → IPC → SQLite
  → activateTheme(stored.theme)              from the authoritative answer
  → invoke('system.applyTheme')              → nativeTheme.themeSource
                                             (traffic lights, native dialogs)
```

and on the next launch:

```
main:     settings.get().theme → resolveTheme(…, nativeTheme.shouldUseDarkColors)
          → BrowserWindow({ backgroundColor: WINDOW_BACKGROUND[theme] })
renderer: bootstrap → settings loaded → activateTheme(theme) → first React frame
```

Both sides call the same `resolveTheme`, which is why they cannot disagree
about the frame that is painted before the renderer exists.

Navigation, the only interaction the shell owns end to end:

```
click NavRail button
  → useUiStore.setPage('agents')
  → AppShell re-renders, unmounts ChatsPage, mounts AgentsPage
```

No backend, no persistence: reopening the app starts on Chats.

The language switch, which is the shell's one backend path and is
[S1.4's](../i18n/implement.md) machinery reached from a new place:

```
click a segment of the quick toggle  (or pick from the Appearance select)
  → applyLanguageSetting(setting)            pages/settings/language.ts
  → useSettingsStore.setLanguage(setting)    optimistic local write
  → BackendClient.invoke('settings.update')  → IPC → SQLite
  → store replaced with the authoritative row
  → i18n.changeLanguage(resolveLanguage(…))  → whole tree re-renders
  (rejection) → useSettingsStore.setState({ error })  → shown in Settings → Developer
```

Both controls read `settings.language` from the same store, so they are two views
of one setting rather than two settings.

The Developer section keeps the S1.3 traces unchanged: `system.ping` on mount for
request/response, `subscribe` for push, `system.emitTestEvent` behind the button.

## Key types and contracts

Everything new is renderer-local; no shared type and no IPC channel was added.

| Export | Where | Notes |
|---|---|---|
| `Page`, `SettingsSection`, `PAGES`, `SETTINGS_SECTIONS`, `useUiStore` | `stores/ui.ts` | `SETTINGS_SECTIONS` is the render order of the settings nav |
| `presenceColorClass(state)` | `components/ui/presence-dot.tsx` | `PresenceState` → `bg-presence-*`. Pure, total, unit-tested |
| `TRAFFIC_LIGHT_INSET`, `DRAG_REGION`, `NO_DRAG` | `components/layout/window-chrome.ts` | Class names, not styles |
| `applyLanguageSetting(setting)` | `pages/settings/language.ts` | The single handler both language controls call |
| `applyThemeSetting(setting)` | `pages/settings/theme.ts` | Its counterpart for the appearance control (S5.8) |
| `resolveTheme`, `ResolvedTheme`, `WINDOW_BACKGROUND` | `src/shared/theme.ts` | The rule and the one duplicated colour, shared with the main process |
| `applyTheme`, `activateTheme`, `stampTheme`, `prefersDarkScheme`, `THEME_ATTRIBUTE` | `src/renderer/src/lib/theme.ts` | `activateTheme` owns the window's single `matchMedia` subscription |
| `openDeveloperSettings(window)` | `e2e/helpers.ts` | Navigates a spec to Settings → Developer |

Types consumed from `@shared/types`: `PresenceState`, `ChatMode`, `SpeakingMode`,
`DEFAULT_CHAT_SETTINGS`, `DEFAULT_APP_SETTINGS`.

S5.8 added one `BackendClient` method, `system.applyTheme` — see
[`../backend-client/backend.md`](../backend-client/backend.md). No event.

## Tests

| File | Covers |
|---|---|
| `src/renderer/src/stores/ui.test.ts` | Defaults, both setters over every value, and that the two fields are independent — leaving Settings must not reset the section |
| `src/renderer/src/components/ui/presence-dot.test.ts` | `presenceColorClass`: the four mappings, that they are distinct, and that each is a literal token utility rather than an interpolated class |
| `src/renderer/src/lib/theme.test.ts` | `resolveTheme` over all six combinations; `applyTheme` / `activateTheme` against a faked `document` and `matchMedia` (including that leaving `'system'` unsubscribes); and the palette itself — every `--color-*` token overridden, every override a different value, `color-scheme` on both roots, and `--color-bg-base` equal to `WINDOW_BACKGROUND` |
| `src/renderer/src/lib/highlighter.test.ts` | That `highlightCode` emits `--shiki-light` and `--shiki-dark` and no literal `color:` — the contract the two `.shiki` rules in `index.css` depend on |
| `src/renderer/src/stores/settings.test.ts` | `setTheme`: the patch, the optimistic repaint, `system.applyTheme`, and that `'system'` is stored unresolved |
| `e2e/theme.spec.ts` | The three-segment control, `prefers-color-scheme` through `page.emulateMedia`, the choice surviving a restart including `BrowserWindow.getBackgroundColor()`, and five light screenshots |
| `src/renderer/src/i18n/locales.test.ts` | Updated: `EXPECTED_NAMESPACES` no longer lists `smoke`. Still guards the key trees, CJK, placeholders |
| `src/renderer/src/i18n/used-keys.test.ts` | Unchanged, and it did its job twice during S1.5 — once on a runtime-assembled key, once on a `switch` returning adjacent JSX |
| `e2e/ui-shell.spec.ts` | Rail navigation with one page mounted at a time, section switching, the section surviving a page change, and the three 1440×900 screenshots |
| `e2e/smoke.spec.ts` | Unchanged assertions, now reached through Settings → Developer |
| `e2e/i18n.spec.ts` | The quick toggle, the Appearance select as the same setting, and survival across a restart |

Screenshots land in `$WITENA_SHOTS_DIR` (default: `test-results/shots`, gitignored). They are meant for a human reviewer, not for pixel comparison: a pixel baseline would fail on every font-rendering difference between machines.

## Known limitations and TODOs

- **The default `WITENA_SHOTS_DIR` is a machine-specific absolute path.** It was
  the review directory for S1.5. Point it somewhere inside the repo (and gitignore
  it) the next time the spec is touched.
- **Group settings are not persisted.** Local `useState` in `ChatsPage`; S2.2
  replaces it with the chat's `ChatSettings`.
- ~~**Nothing renders a `PresenceDot` yet.**~~ S1.7 renders it in two places: on
  every agent message avatar and in the member panel, driven by
  `stores/presence.ts`. Only `working` and `available` are emitted until S2.4
  adds the supervisor. One layout note learnt there: an `Avatar` inside a flex row
  needs `self-start`, or the wrapper stretches to the row's height and the
  overlaid dot — positioned against its bottom edge — floats away from it.
- **Two tokens were added in S1.7**: `--color-avatar-user` and
  `--color-avatar-user-fg`, the human's monogram tile from the mockup. Agent
  avatar colours are *data* (each record stores its own), but the user has no
  record, so its pair is a token like every other literal colour.
- **`Avatar` has no image or emoji variant.** `AgentAvatar` is a union with one
  member today; the component takes text and colours directly rather than the
  whole record, which is the change to make when a second variant appears.
- **`vitest.config.ts` has `css: true` since S5.8.** Vitest otherwise stubs
  every CSS import with an empty module, and that stub also swallows
  `import.meta.glob('../index.css', { query: '?raw' })`, which is how the token
  test reads the palette. No plugin is configured in that file, so the cost is
  reading one file.
- **The renderer bundle is ~795 kB.** Mostly React plus the lucide icons that are
  actually imported. Worth a look at S4.4 (packaging), not before.
