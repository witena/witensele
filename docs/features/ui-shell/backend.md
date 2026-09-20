# ui-shell — Backend

**This feature has no main-process code.** S1.5 added no module under
`src/main/`, no table, no migration, no IPC handler and no event. The shell is
renderer-only; see [frontend.md](./frontend.md).
Still true after S9.3: `Dialog`, the first modal primitive, is CSS, a focus
trap and two event listeners — there is no native window, no `BrowserWindow`
option and no main-process involvement of any kind.

One main-process fact it depends on, and one it does not want changed:

## Window options

`createWindow` in `src/main/index.ts` is the whole contract:

| Option | Value | Why the shell cares |
|---|---|---|
| `width` / `height` | 1440 × 900 | The mockup's artboard size. `e2e/ui-shell.spec.ts` forces the same content size before taking screenshots so they stay comparable |
| `minWidth` / `minHeight` | 1100 × 700 | Below this the three columns (56 + 264 + 288 fixed) leave the conversation too narrow to read |
| `titleBarStyle` | `'hiddenInset'`, macOS only | There is no system title bar, so the renderer supplies its own drag regions and a 32px top inset on the leftmost column. See "Window chrome" in [frontend.md](./frontend.md). Changing or removing this option breaks both. It is also why `nativeTheme.themeSource` matters: the traffic lights drawn over the content are the platform's, and only that property tells it which way to draw them |
| `backgroundColor` | `WINDOW_BACKGROUND[resolveTheme(stored, nativeTheme.shouldUseDarkColors)]` | The `bg-base` token of the theme that is about to be painted (S5.8; it was the literal `#171614` before). `createWindow` reads `ctx.repos.settings.get().theme` for this, which is why it is called after the context exists. A wrong value here is a flash of the other theme on every launch, and no stylesheet can correct a frame that is already on screen |
| `show` | `false` until `ready-to-show` | Same reason: no half-painted first frame |
| `autoHideMenuBar` | `true` | Non-macOS platforms; nothing in the shell depends on a menu |

`titleBarStyle` is applied only on `darwin`. On another platform the window keeps
its native title bar, the drag regions are harmless, and the 32px inset is merely
a slightly taller column header — nothing breaks, but the layout has not been
reviewed there.

## The theme, which the renderer cannot finish on its own

S5.8 gave the shell its second main-process fact. Two lines of `src/main/index.ts`
and one handler module:

| Where | What |
|---|---|
| `currentThemeSetting()` in `src/main/index.ts` | `ctx.repos.settings.get().theme`, falling back to `DEFAULT_APP_SETTINGS.theme` before the context exists |
| `createWindow` | Resolves it with `nativeTheme.shouldUseDarkColors` and paints `WINDOW_BACKGROUND[theme]` |
| `whenReady` | `nativeTheme.themeSource = currentThemeSetting()`, so the chrome is right from the first window rather than after the user visits Settings. `themeSource` takes `'system'` verbatim, so following the machine needs no listener here |
| `src/main/ipc/theme.ts` | `system.applyTheme`, the live updates from the settings control. The **second** handler that must import electron, arranged exactly like `dialogs.ts` |

`resolveTheme` and `WINDOW_BACKGROUND` come from `@shared/theme` — the renderer
uses the same function against `matchMedia`, which is what keeps the window's
first frame and the page's first frame the same colour.

**S5.17 added no main-process code either**, and that is the point of how the
monogram palette was built. An avatar could have been themed by migrating
`agents.avatar` to new hexes, which would have made the appearance a *database*
concern: a migration to write, a downgrade to think about, and a half-converted
table if the app were killed during it. Storing an index instead keeps the whole
change inside the stylesheet and one pure renderer function. The only thing the
main process knows about it is that `defaultAgentInput` now writes
`palette: DEFAULT_AGENT_AVATAR_PALETTE` beside the colour it already wrote —
one field on one record, with no validation of its own, because `agents.create`
has never inspected the inside of an avatar.

One thing the main process must **keep** doing: accepting an `avatar` object it
does not fully understand. `handlers/agents.ts` checks that it is an object and
nothing more, and the repository stores it as JSON. That is what let `palette`
appear without a migration, and it is the reason to leave that check alone.

## The build step Settings → About depends on (S7.5)

About renders a list this feature does not write by hand, and the file it reads
does not exist in a fresh checkout:

| Where | What |
|---|---|
| `scripts/generate-licenses.mjs` | Walks the transitive closure of `package.json`'s `dependencies` through `node_modules/*/package.json` and writes `src/renderer/src/generated/licenses.json`. Plain Node, no electron, part of neither TypeScript project |
| `package.json` | The `licenses` script, plus the `pretypecheck` / `pretest` / `pretest:watch` / `predev` / `prebuild` hooks that run it |
| `.gitignore` | `src/renderer/src/generated` — the file is derived, so it is reproduced rather than reviewed |
| `src/main/licenses.test.ts` | Runs the script against a fixture tree, and checks the real output exists |

Two environment variables exist for the test and for nothing else:
`WITENA_LICENSES_ROOT` (which project to read) and `WITENA_LICENSES_OUT` (where
to write). Neither is read at runtime — by the time the app starts, the JSON is
part of the renderer bundle.

## Database

None. Navigation state is deliberately not persisted: `stores/ui.ts` is local
state and the app opens on Chats every time.

`AppSettings.onboardingDismissed` (S7.5) is stored, but it belongs to the
first-run card: the flag is described in
[`../chats/backend.md`](../chats/backend.md), and the settings row it lives in is
[`../i18n/backend.md`](../i18n/backend.md)'s.

The only stored value the shell reads or writes is `AppSettings.language`, which
belongs to [`../i18n/backend.md`](../i18n/backend.md) and reaches the renderer
through the existing `settings.get` / `settings.update` handlers.

## IPC handlers

`system.applyTheme` (S5.8), declared in `handlers/system.ts` as a rejection and
implemented in `src/main/ipc/theme.ts`; see
[`../backend-client/backend.md`](../backend-client/backend.md).

S7.4 added the three the Updates block calls — `system.updateStatus`,
`system.checkForUpdates` and `system.installUpdate` — which are **not** stubs
here: the updater is injected rather than layered, so `handlers/system.ts`
implements all three against `ctx.updates`, an Electron-free `UpdateService` that
exists in every build. A build with no `electron-updater` behind it answers
`{ state: 'unsupported', reason }` instead of rejecting, which is what lets this
screen print a reason rather than an error. The mechanism is documented in
[`../backend-client/backend.md`](../backend-client/backend.md), "The fifth
exception", and what the *build* has to produce for it in
[`../packaging/backend.md`](../packaging/backend.md), "Auto-update".

Otherwise none added. The Developer section drives the three that already exist —
`system.ping`, `system.emitTestEvent` and `settings.update` — through the
`BackendClient`, exactly as the smoke screen did before it moved.

## The brand mark, which is not a main-process fact either

S7.1 put the Aperture mark on the rail and changed the accent, and added **no**
main-process code for it: the mark is an inlined SVG in
`components/ui/brand-mark.tsx` and the accent is two lines of `index.css`.

The one thing worth naming here is what did **not** change. `WINDOW_BACKGROUND`
in `@shared/theme` and the `backgroundColor` the table above describes are
`bg-base`, not `accent`, so the new accent does not touch the first frame and the
duplicated-colour test in `lib/theme.test.ts` needed no edit. The application
icon is likewise a **build** input rather than a runtime one — `electron-builder`
copies `build/icon.icns` into the bundle and macOS reads it from there; no
Electron API sets it, and `src/main/index.ts` never names it. See
[`../packaging/backend.md`](../packaging/backend.md), "Building the icon".

## Events emitted

None added. Three are **consumed**: `update.available` and `update.downloaded`
since S7.4, through `lib/event-bridge.ts` into `stores/updates.ts` (emitted by
the `UpdateService`,
[`../backend-client/backend.md`](../backend-client/backend.md)), and
`ui.open-chat` since S10.3, which is the only event that asks the *interface*
for something rather than reporting a change in the data. The bridge hands it to
the chats store and, when that store really selected the chat, calls
`setPage('chats')`. It is emitted by `src/main/index.ts`; see
[`../mcp-endpoint/backend.md`](../mcp-endpoint/backend.md).

## When there is no window (S10.3)

A second main-process fact the shell now depends on, alongside the window
options above: **`createWindow()` at ready is conditional.** A launch carrying
`--background` creates no window at all, which is how the MCP shim starts Witena
for a coding agent. Nothing in the renderer changes — there simply is no
renderer yet — and the way back in is the `activate` handler the app has always
had for "the user closed the last window on macOS".

`src/main/index.ts` also gained `showOrCreateWindow()`, which `second-instance`
and a `witena://` link both go through: it restores a minimized window, focuses
an existing one, or creates one. The shell's single-window assumption is what
makes that one function rather than a window manager.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `lucide-react` | Every icon in the shell | Stroke icons only, no emoji. Import the named components you use — a namespace import would pull the whole set into the bundle |
| `tailwindcss` v4 | Tokens and utilities | Class names are found by scanning source *text*: an interpolated class (`` `bg-presence-${state}` ``) compiles and then renders nothing. Vendor-prefixed arbitrary properties (`[-webkit-app-region:drag]`) collide with the negative-value syntax, so those two are `@utility` declarations in `index.css` |
| `zustand` | `stores/ui.ts` | Module-level singleton: a unit test must reset the state in `beforeEach` or it inherits whatever the previous test navigated to |
| `i18next` | Every string | `count` is a reserved interpolation name that switches on plural resolution. Use any other placeholder name unless plurals are actually wanted |
