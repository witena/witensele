# ui-shell — Backend

**This feature has no main-process code.** S1.5 added no module under
`src/main/`, no table, no migration, no IPC handler and no event. The shell is
renderer-only; see [frontend.md](./frontend.md).

One main-process fact it depends on, and one it does not want changed:

## Window options

`createWindow` in `src/main/index.ts` is the whole contract:

| Option | Value | Why the shell cares |
|---|---|---|
| `width` / `height` | 1440 × 900 | The mockup's artboard size. `e2e/ui-shell.spec.ts` forces the same content size before taking screenshots so they stay comparable |
| `minWidth` / `minHeight` | 1100 × 700 | Below this the three columns (56 + 264 + 288 fixed) leave the conversation too narrow to read |
| `titleBarStyle` | `'hiddenInset'`, macOS only | There is no system title bar, so the renderer supplies its own drag regions and a 32px top inset on the leftmost column. See "Window chrome" in [frontend.md](./frontend.md). Changing or removing this option breaks both |
| `backgroundColor` | `#171614` | The `bg-base` token, so the window paints the app's own dark before the renderer's first frame instead of flashing white |
| `show` | `false` until `ready-to-show` | Same reason: no half-painted first frame |
| `autoHideMenuBar` | `true` | Non-macOS platforms; nothing in the shell depends on a menu |

`titleBarStyle` is applied only on `darwin`. On another platform the window keeps
its native title bar, the drag regions are harmless, and the 32px inset is merely
a slightly taller column header — nothing breaks, but the layout has not been
reviewed there.

## Database

None. Navigation state is deliberately not persisted: `stores/ui.ts` is local
state and the app opens on Chats every time.

The only stored value the shell reads or writes is `AppSettings.language`, which
belongs to [`../i18n/backend.md`](../i18n/backend.md) and reaches the renderer
through the existing `settings.get` / `settings.update` handlers.

## IPC handlers

None added. The Developer section drives the three that already exist —
`system.ping`, `system.emitTestEvent` and `settings.update` — through the
`BackendClient`, exactly as the smoke screen did before it moved.

## Events emitted

None added.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `lucide-react` | Every icon in the shell | Stroke icons only, no emoji. Import the named components you use — a namespace import would pull the whole set into the bundle |
| `tailwindcss` v4 | Tokens and utilities | Class names are found by scanning source *text*: an interpolated class (`` `bg-presence-${state}` ``) compiles and then renders nothing. Vendor-prefixed arbitrary properties (`[-webkit-app-region:drag]`) collide with the negative-value syntax, so those two are `@utility` declarations in `index.css` |
| `zustand` | `stores/ui.ts` | Module-level singleton: a unit test must reset the state in `beforeEach` or it inherits whatever the previous test navigated to |
| `i18next` | Every string | `count` is a reserved interpolation name that switches on plural resolution. Use any other placeholder name unless plurals are actually wanted |
