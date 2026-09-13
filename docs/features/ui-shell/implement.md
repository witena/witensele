# ui-shell — Implementation

## Approach

Three layers, bottom up.

**Tokens.** `src/renderer/src/index.css` declares every colour, the two font
stacks and (new in S1.5) the `drag-region` / `no-drag` utilities inside
`@theme static` / `@utility`. No component contains a literal colour; the one
exception is *data* — an agent's `avatar.color` — which arrives as an inline
style because Tailwind cannot see a value that only exists at runtime.

**Primitives.** `components/ui/` holds the vocabulary: `Button`, `IconButton`,
`Input`, `TextArea`, `Select`, `Toggle`, `SegmentedControl`, `Badge`, `Avatar`,
`PresenceDot`, `EmptyState`, `SectionTitle`, `Field`. They are presentational and
stateless — every one takes already-translated strings, so no primitive imports
`react-i18next` and none of them can leak an untranslated literal.
`components/layout/` holds `Column` (fixed width, one border, its own scroll
context), `PageHeader` (the 52px bar) and `window-chrome.ts` (the constants for
living under a hidden title bar).

**Shell and pages.** `App.tsx` is a composition root and nothing else; it renders
`AppShell`, which renders `NavRail` plus the page named by `stores/ui.ts`. The
three pages sit in `pages/`, with the two settings sections that have content in
`pages/settings/`.

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
| `openDeveloperSettings(window)` | `e2e/helpers.ts` | Navigates a spec to Settings → Developer |

Types consumed from `@shared/types`: `PresenceState`, `ChatMode`, `SpeakingMode`,
`DEFAULT_CHAT_SETTINGS`, `DEFAULT_APP_SETTINGS`.

No `BackendClient` method and no event is added by this feature.

## Tests

| File | Covers |
|---|---|
| `src/renderer/src/stores/ui.test.ts` | Defaults, both setters over every value, and that the two fields are independent — leaving Settings must not reset the section |
| `src/renderer/src/components/ui/presence-dot.test.ts` | `presenceColorClass`: the four mappings, that they are distinct, and that each is a literal token utility rather than an interpolated class |
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
- **Nothing renders a `PresenceDot` yet.** The component and its token mapping
  exist so S2.4 has nothing to design; the member panel is empty until S2.2.
- **`Avatar` has no image or emoji variant.** `AgentAvatar` is a union with one
  member today; the component takes text and colours directly rather than the
  whole record, which is the change to make when a second variant appears.
- **The renderer bundle is ~795 kB.** Mostly React plus the lucide icons that are
  actually imported. Worth a look at S4.4 (packaging), not before.
