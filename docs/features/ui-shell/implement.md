# ui-shell — Implementation

## Approach

Three layers, bottom up. (S7.4 added one surface that sits outside all three —
the update notice bar, which is chrome rather than a page; see "Key types and
contracts" and [`frontend.md`](./frontend.md).)

**Tokens.** `src/renderer/src/index.css` declares every colour, the two font
stacks and (new in S1.5) the `drag-region` / `no-drag` utilities inside
`@theme static` / `@utility`. No component contains a literal colour. Something
chosen at runtime — an avatar's tile, a provider's monogram — still arrives as an
inline style, because Tailwind cannot see a class it never scans; since S5.17
that inline style is a `var(--color-avatar-N-bg)` **reference** rather than a
hex, which is what makes the last two coloured things in the app follow the
appearance. `lib/hex-literals.test.ts` is the guard.

Since S5.8 that block is the **dark** palette and `:root[data-theme='light']`
overrides every `--color-*` token in it, with `color-scheme` set on both roots
so scrollbars, selection and the native `<select>` follow. A utility compiles
to `var(--color-…)`, so the attribute on `<html>` is the entire switch: nothing
re-renders, no component reads the theme, and a screen written in a later step
is themed the day it is written. The rule this creates: **a token added to
`@theme static` must be added to the light block as well**, and
`lib/theme.test.ts` fails when it is not.

S5.17 added two blocks after it, `@media (prefers-contrast: more)` and
`@media (prefers-reduced-transparency: reduce)`, each stating its overrides
**twice** — once for `:root` and once for `:root[data-theme='light']`. That
repetition is load-bearing rather than sloppy: the light block's selector is
specificity (0,2,0) and outranks a bare `:root` however late the media query
appears, so one unqualified block would strengthen the dark theme and silently do
nothing in the light one. The test asserts both halves name the same tokens.

### The review harness (S5.17)

`e2e/theme-review.spec.ts` is the only way this feature's acceptance criterion —
"every screen is readable in both appearances" — can be checked, because it is
not a thing Playwright can assert. It seeds a plausible installation and writes
forty-two full-window screenshots for a human to open.

Three seams, in order of how far each reaches around the app:

1. **Records go through the backend client.** `providers.create`,
   `agents.create`, `chats.create` — the same calls the UI makes.
2. **The transcript is written into `witena.db` with `node:sqlite`, with the app
   closed.** There is no `messages.append` method and there should not be one:
   nothing but a run may write a message. A review harness reaches around the
   app rather than the app growing a seam for it. `node:sqlite` rather than
   `better-sqlite3` because `postinstall` rebuilds that one for Electron's ABI,
   and the Playwright runner is plain Node.
3. **The pending permission card is a real event on the real channel.** A prompt
   is not a row, it is a suspended tool call, so the spec sends
   `permission.requested` from the main process down `witena:event` —
   `PermissionGate`'s own path through preload, `event-bridge` and the store —
   and `permission.resolved` afterwards, because a card that stays open appears
   in every screenshot taken after it.

Two things the first pass taught, both now in the file: the walk **reloads the
renderer** before each appearance (the first pass photographed a provider editor
the previous pass had left open), and every shot waits 350ms for
`transition-colors` to finish (several landed mid-transition, with the header
naming one settings section and the highlight still on the previous one — which
reads as a bug in a review).

S7.1 changed the accent and added one token. The accent is now the brand
terracotta — `#d97757` in the dark palette, `#a13917` in the light one — so the
colour every button, focus ring, chip and link in the app uses is the colour at
the centre of the icon in the Dock. The new token is `--color-brand-point`, and
it is the **one** token that is deliberately identical in both palettes: it is an
identity rather than a role. It is still declared in both blocks, so the "every
token is overridden" check still sees it; the "every override differs" check has
a named exception set, `CONSTANT_TOKENS`, which the test's own comment asks to
keep tiny.

**Primitives.** `components/ui/` holds the vocabulary: `Button`, `IconButton`,
`Input`, `TextArea`, `Select`, `Toggle`, `SegmentedControl`, `Badge`, `Avatar`,
`PresenceDot`, `EmptyState`, `SectionTitle`, `Field`, `BrandMark`. They are presentational and
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
`pages/settings/` (providers, appearance, timeouts, **about**, developer).

**Settings → About (S7.5)** is one more entry in `SETTINGS_SECTIONS` and one
more `if` in `SectionBody`; it needed no new primitive and no backend call. Its
only unusual ingredient is the licence list, which is **generated rather than
written**:

```
scripts/generate-licenses.mjs          reads package.json + node_modules/*/package.json
  → src/renderer/src/generated/licenses.json     (gitignored)
      → src/renderer/src/lib/licenses.ts          the only file that knows its shape
          → pages/settings/about-section.tsx      counts first, then the rows
```

The script walks the **transitive closure of `dependencies`** — what actually
ships — never `devDependencies`, reads both of npm's licence spellings
(`license`, and the pre-2014 `licenses` array), writes `UNKNOWN` rather than
hiding a package that declares neither, and warns about a declared dependency
that is not installed instead of silently dropping it. `package.json` runs it
from `pretypecheck`, `pretest`, `predev` and `prebuild`, so every path that
needs the file makes it first — including a clean `npm ci && npm run typecheck`
on CI, which is why the file can be gitignored at all.

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

Settings → About has no data flow: `APP_VERSION`, `APP_REPOSITORY_URL` and the
generated licence array are all compile-time constants. The only runtime edge is
the repository link, which leaves the app entirely:

```
click the repository link (target="_blank")
  → Chromium asks to open a window
  → setWindowOpenHandler in src/main/index.ts
      isExternalUrl(url) ? shell.openExternal(url) : nothing
  → { action: 'deny' }                     no second BrowserWindow, ever
```

The shell's one inbound navigation path, added by S10.3:

```
a witena://chat/<id> link, from anywhere on the machine
  → open-url (or second-instance argv)      src/main/index.ts
  → show or create the window
  → ui.open-chat on the event bus           after did-finish-load
  → applyBackendEvent                       lib/event-bridge.ts
      useChatsStore.applyOpenRequest(id)
        selected? → useUiStore.setPage('chats')
        not this window's chat? → nothing at all, and no error
```

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
| `updateStateLabel`, `unsupportedLabel`, `canCheckForUpdates`, `TranslateFn` | `src/renderer/src/lib/updates.ts` | S7.4. The status as one translated sentence, and whether the button can be pressed. Pure, so `t` is declared structurally and the test needs no i18next — note `params` is **required** rather than optional, because an optional second argument is not assignable to i18next's overloaded `t` under `exactOptionalPropertyTypes` |
| `useUpdatesStore`, `updateReadyVersion`, `useUpdateReady`, `UpdatesState` | `src/renderer/src/stores/updates.ts` | S7.4. `updateReadyVersion` is a plain function of `(status, dismissedVersion)` and the hook is one line over it, so the rule that decides whether a persistent strip covers part of the window is testable without React |
| `BUNDLED_LICENSES`, `licenseSummary`, `LicenseEntry` | `src/renderer/src/lib/licenses.ts` | The typed view of the generated JSON, and the per-licence counts About leads with (S7.5) |
| `APP_REPOSITORY_URL` | `src/shared/version.ts` | Next to `APP_VERSION`, because About renders the two together (S7.5) |
| `resolveTheme`, `ResolvedTheme`, `WINDOW_BACKGROUND` | `src/shared/theme.ts` | The rule and the one duplicated colour, shared with the main process |
| `applyTheme`, `activateTheme`, `stampTheme`, `prefersDarkScheme`, `THEME_ATTRIBUTE` | `src/renderer/src/lib/theme.ts` | `activateTheme` owns the window's single `matchMedia` subscription |
| `openDeveloperSettings(window)` | `e2e/helpers.ts` | Navigates a spec to Settings → Developer |

Types consumed from `@shared/types`: `PresenceState`, `ChatMode`, `SpeakingMode`,
`DEFAULT_CHAT_SETTINGS`, `DEFAULT_APP_SETTINGS`.

S5.8 added one `BackendClient` method, `system.applyTheme` — see
[`../backend-client/backend.md`](../backend-client/backend.md). No event.

S7.4 added three (`system.updateStatus`, `system.checkForUpdates`,
`system.installUpdate`), the `UpdateStatus` type in `@shared/updates`, and the
first event pair this feature listens to (`update.available`,
`update.downloaded`, fanned out by `lib/event-bridge.ts` like every other).

## Tests

| File | Covers |
|---|---|
| `src/renderer/src/stores/ui.test.ts` | Defaults, both setters over every value, and that the two fields are independent — leaving Settings must not reset the section |
| `src/renderer/src/components/ui/presence-dot.test.ts` | `presenceColorClass`: the four mappings, that they are distinct, and that each is a literal token utility rather than an interpolated class |
| `src/renderer/src/lib/theme.test.ts` | `resolveTheme` over all six combinations; `applyTheme` / `activateTheme` against a faked `document` and `matchMedia` (including that leaving `'system'` unsubscribes); and the palette itself — every `--color-*` token overridden, every override a different value **except the `CONSTANT_TOKENS` set**, which must instead be repeated verbatim, `color-scheme` on both roots, `--color-bg-base` equal to `WINDOW_BACKGROUND`, all eight avatar slots defined both ways in both blocks, and (S5.17) the whole contrast contract: every body-copy step AA-normal and every small-print step ≥ 3:1 on all six surfaces, every monogram AA on its own tile, every status pill on its own surface, every presence dot ≥ 3:1 on `bg-panel`, the light foreground steps no quieter than the dark ones, both accessibility media queries naming the same tokens in both appearances and actually *raising* contrast, and `--color-bg-subtle` being the only token with an alpha channel |
| `src/renderer/src/lib/contrast.test.ts` | The instrument itself (S5.17): both hex lengths, a throw rather than a `NaN` on anything else (a `NaN` ratio makes every assertion above pass for the wrong reason), the 1–21 range, symmetry, WCAG's own worked example (`#777` on white is 4.48:1) and the RGB distance the avatar mapping is built on |
| `src/renderer/src/lib/hex-literals.test.ts` | Guard #3 (S5.17): no colour literal anywhere in the renderer outside the three named files, with comments blanked out and test files unscanned. It also asserts the exemption list still names files that exist, and that the pattern really does find the sixteen hexes in the legacy table — a guard that matches nothing passes by accident |
| `src/renderer/src/components/ui/brand-mark.test.ts` | The mark in the rail and the mark the application icon is cut from are the same drawing: hexagon path, six blade endpoints, point, stroke weight and the `geometricPrecision` hint all compared against `build/icon.svg` and `build/icon-dark.svg`. Plus the S7.1 acceptance criterion — `nav-rail.tsx` renders `<BrandMark`, no longer renders the `W` tile, sizes it `h-7 w-7` and colours it `text-fg` |
| `src/renderer/src/lib/highlighter.test.ts` | That `highlightCode` emits `--shiki-light` and `--shiki-dark` and no literal `color:` — the contract the two `.shiki` rules in `index.css` depend on |
| `src/renderer/src/stores/settings.test.ts` | `setTheme`: the patch, the optimistic repaint, `system.applyTheme`, and that `'system'` is stored unresolved |
| `e2e/theme.spec.ts` | The three-segment control, `prefers-color-scheme` through `page.emulateMedia`, the choice surviving a restart including `BrowserWindow.getBackgroundColor()`, and five light screenshots |
| `e2e/theme-review.spec.ts` | **An instrument, not a test** (S5.17). Seeds two providers, five agents (four with a palette index, one with a legacy hex only), a chat with a working directory and a document goal, and a transcript holding every part kind; then photographs twenty-one screens in each appearance into `test-results/theme-review/`. It asserts only that the screen it photographed was on screen. See "The review harness" above |
| `src/renderer/src/i18n/locales.test.ts` | Updated: `EXPECTED_NAMESPACES` no longer lists `smoke`. Still guards the key trees, CJK, placeholders |
| `src/renderer/src/i18n/used-keys.test.ts` | Unchanged, and it did its job twice during S1.5 — once on a runtime-assembled key, once on a `switch` returning adjacent JSX |
| `src/main/licenses.test.ts` | `scripts/generate-licenses.mjs` driven as an executable against a fixture `node_modules`: the production closure and nothing else, transitive edges and a cycle, both licence spellings, `UNKNOWN`, a normalised git URL, the warning for a package that is not installed — plus that the generated file the renderer imports actually exists, which is also the check that the `pretest` hook is still wired up (S7.5) |
| `e2e/onboarding.spec.ts` | Its last case: About shows `package.json`'s version, an `https://github.com/…` link and a non-trivial licence list (S7.5) |
| `src/renderer/src/lib/updates.test.ts` | S7.4: every one of the eight update states reaching a **distinct** key that `en.json` actually defines — the runtime half of rule #4, since `used-keys.test.ts` can only see the literal calls — the parameters each sentence needs, and when "Check for updates" is offered |
| `src/renderer/src/stores/updates.test.ts` | S7.4: the mirror, a backend with no such method not breaking the screen, the busy flag, both events through `applyBackendEvent`, an `available` event never undoing a finished download, and the dismissal rule — closed for this version, open again for the next |
| `e2e/updates.spec.ts` | S7.4: an ordinary launch is a checkout, so About says why there is nothing to check and the button is disabled; with `WITENA_UPDATE_FEED` the offered version travels all the way to the sentence on screen |
| `e2e/ui-shell.spec.ts` | Rail navigation with one page mounted at a time, section switching, the section surviving a page change, and the three 1440×900 screenshots |
| `e2e/launch.spec.ts` | S10.3, and the shell's stake in it: a `--background` launch has no window and `activate` still opens one; a `witena://` link opens one; two apps with different `WITENA_USER_DATA` run side by side. Owned by [`../mcp-endpoint/backend.md`](../mcp-endpoint/backend.md) |
| `src/renderer/src/stores/chats.test.ts` | S10.3: `describe('ui.open-chat')` — the only place `setPage` is driven by an event rather than a click. Owned by [`../mcp-endpoint/frontend.md`](../mcp-endpoint/frontend.md) |
| `e2e/smoke.spec.ts` | Unchanged assertions, now reached through Settings → Developer |
| `e2e/i18n.spec.ts` | The quick toggle, the Appearance select as the same setting, and survival across a restart |

Screenshots land in `$WITENA_SHOTS_DIR` (default: `test-results/shots`, gitignored). They are meant for a human reviewer, not for pixel comparison: a pixel baseline would fail on every font-rendering difference between machines.

## Known limitations and TODOs

- **The default `WITENA_SHOTS_DIR` is a machine-specific absolute path.** It was
  the review directory for S1.5. Point it somewhere inside the repo (and gitignore
  it) the next time the spec is touched.
- **The notice bar has never been seen in a screenshot** (S7.4). It is asserted
  in `e2e/updates.spec.ts` only through the `downloaded` state, which an ordinary
  e2e run cannot reach — that needs two signed bundles and a local feed, which is
  a packaging procedure rather than a spec. It *was* seen, and read, during the
  manual run recorded in STEPS.md S7.4, in dark mode at 1440×900; it has not been
  looked at in the light theme, and it is not in the `e2e/theme.spec.ts` shots.
- **`AppShell` became a column for one strip.** The rail and the page now sit in
  a `flex-1` row inside a `flex-col`, which is a layout every screen pays for and
  almost no screen uses. It costs nothing measurable and it is the honest shape
  for "something can appear below the app", but it is worth knowing the wrapper
  exists if a later step wonders where the extra div came from.
- **Group settings are not persisted.** Local `useState` in `ChatsPage`; S2.2
  replaces it with the chat's `ChatSettings`.
- ~~**Nothing renders a `PresenceDot` yet.**~~ S1.7 renders it in two places: on
  every agent message avatar and in the member panel, driven by
  `stores/presence.ts`. Only `working` and `available` are emitted until S2.4
  adds the supervisor. One layout note learnt there: an `Avatar` inside a flex row
  needs `self-start`, or the wrapper stretches to the row's height and the
  overlaid dot — positioned against its bottom edge — floats away from it.
- **The mark is tested as values, not as markup.** There is no jsdom in this
  repository (`vitest.config.ts` runs everything in `environment: 'node'`), so
  `BrandMark` follows `PresenceDot`: the part worth asserting is exported as
  plain data (`BRAND_MARK_HEXAGON`, `BRAND_MARK_BLADES`, `BRAND_MARK_POINT`) and
  the test compares it with `build/icon.svg` read as text. That is a **stronger**
  test than rendering would have been — rendering proves the component draws
  something, while this proves the Dock icon and the rail are the same mark,
  which is the thing nothing else in the build checks. "The rail renders the mark
  rather than a letter" is asserted against `nav-rail.tsx`'s source text, the same
  technique `used-keys.test.ts` uses on every component.
- **Two tokens were added in S1.7**: `--color-avatar-user` and
  `--color-avatar-user-fg`, the human's monogram tile from the mockup. S5.17
  joined them with the eight indexed slots and a neutral pair, and retuned all
  three groups; the user's tile is now kept a step deeper than slot 5's green so
  "you" and "an agent" do not read as the same person.
- **The contrast matrix is computed from *tokens*, not from pixels.** It is exact
  for text on a plain surface and blind to anything composited on top — which is
  how a passed row drawn at `opacity-50` stayed 3.26:1 in the light theme from
  S2.x until someone looked at a screenshot in S5.17. The two remaining
  composites (`opacity-70` on a dimmed row, `opacity-45` on a disabled control)
  were checked by hand; measuring them would need a real browser and a sampler.
- **The nearest-hex avatar mapping is RGB distance, and that is all it claims.**
  The eight legacy values round-trip exactly, which is the case that matters. For
  a colour the picker could never have produced it answers *some* slot, always
  the same one — the table it measures against is eight dark slabs, so a bright
  orange lands on the olive slot rather than the terracotta one. Documented in
  `agent-display.test.ts` rather than fixed, because a perceptual space would be
  more colour science than a fallback for impossible data deserves.
- **`Avatar` has no image or emoji variant.** `AgentAvatar` is a union with one
  member today; the component takes text and colours directly rather than the
  whole record, which is the change to make when a second variant appears.
- **`vitest.config.ts` has `css: true` since S5.8.** Vitest otherwise stubs
  every CSS import with an empty module, and that stub also swallows
  `import.meta.glob('../index.css', { query: '?raw' })`, which is how the token
  test reads the palette. No plugin is configured in that file, so the cost is
  reading one file.
- **The licence list is names and versions, not licence *texts*.** Several
  licences (MIT, BSD, Apache-2.0 with a NOTICE) ask for the text to travel with
  the distribution. Shipping 244 `LICENSE` files is a packaging decision rather
  than a screen, so About links the package's homepage instead; the full-text
  question is recorded under "Release and distribution" in Phase 6.
- **Nothing regenerates the list while `npm run dev` is already running.** The
  hook runs at start-up (`predev`), so a dependency installed mid-session shows
  up on the next start. That is the right trade for a file that changes only
  when `package.json` does.
- **The renderer bundle is ~795 kB.** Mostly React plus the lucide icons that are
  actually imported. Worth a look at S4.4 (packaging), not before.
