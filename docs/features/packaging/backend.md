# packaging — Backend

## Modules

| File | Responsibility |
|---|---|
| `electron-builder.yml` | The whole build configuration: app id, product name, file selection, asar unpacking, extra resources, the macOS target and the signing decision |
| `build/icon.svg` | The mark, drawn by hand: a rounded square in the accent colour `#d8a656` with a white stroked "W" |
| `build/icon.png` | The 1024 px rasterisation of it, and the only input to the iconset |
| `build/icon.icns` | What `mac.icon` points at. Binary, committed, regenerated only when the mark changes |
| `build/icon.iconset/` | The ten intermediate PNGs `iconutil` reads. **Gitignored** — derived and reproducible in one loop |
| `src/main/index.ts` | `bundledSkillsDir()`: the only runtime code that behaves differently in a packaged build |
| `playwright.packaged.config.ts` | Runs `e2e/packaged.spec.ts` and nothing else |
| `e2e/packaged.spec.ts` | The acceptance test against the shipped bundle |
| `playwright.demo.config.ts`, `e2e/demo.record.ts` | The tour recording that produces `docs/assets/` |

`package.json` carries no `build` key: electron-builder finds
`electron-builder.yml` on its own, and one configuration in two places is the
kind of thing that goes stale.

## The builder configuration, field by field

| Field | Value | Why |
|---|---|---|
| `appId` | `com.witena.app` | The bundle identifier macOS keys preferences, keychain entries and the `userData` directory off |
| `productName` | `Witena` | Becomes `Witena.app`, the executable name inside it, and `${productName}` in the dmg's name |
| `directories.output` | `dist` | Already gitignored by the repository's `.gitignore` |
| `directories.buildResources` | `build` | Where electron-builder looks for `icon.icns` by convention; `mac.icon` names it explicitly anyway |
| `files` | `out/**`, `package.json`, minus `*.map` and `.DS_Store` | Everything electron-vite produced, plus the manifest that carries `main` and the dependency list. **`node_modules` is deliberately absent**: electron-builder appends the production dependency tree itself, and a second hand-written copy of that fact would drift |
| `asarUnpack` | `**/node_modules/better-sqlite3/**` | `dlopen` takes a filesystem path. A `.node` binary inside an asar archive is not at one, and the app would fail to open its database on the first launch |
| `extraResources` | `resources` → `resources` | Ships `resources/skills/`. See the path note below |
| `mac.target` | `dmg`, `arch: [arm64]` | One artifact. The zip target exists for auto-update, which the MVP does not have |
| `mac.category` | `public.app-category.developer-tools` | `LSApplicationCategoryType` in the Info.plist |
| `mac.icon` | `build/icon.icns` | Copied to `Contents/Resources/icon.icns` |
| `mac.hardenedRuntime` | `false` | The hardened runtime is a notarization requirement; without a signature it only adds restrictions for nothing |
| `mac.identity` | `null` | No Developer ID signing. Explicit rather than omitted: without it electron-builder picks up whatever identity is in the building machine's keychain, which makes the artifact depend on who built it. See "The unsigned caveat" |
| `dmg.artifactName` | `${productName}-${version}-${arch}.${ext}` | `Witena-0.1.0-arm64.dmg` — the name `e2e/packaged.spec.ts`'s instructions and the release notes both use |

## The resources path

`extraResources` copies `resources/` to `Contents/Resources/resources/`, so the
skills the app ships with live at `process.resourcesPath/resources/skills` once
packaged and at `<appPath>/resources/skills` in a checkout. `bundledSkillsDir()`
is the one function that knows this:

```ts
function bundledSkillsDir(): string {
  const root = app.isPackaged
    ? join(process.resourcesPath, RESOURCES_DIR)
    : join(app.getAppPath(), RESOURCES_DIR)
  return join(root, BUNDLED_SKILLS)
}
```

The nested `Resources/resources` reads oddly and is deliberate: keeping the
folder's own name makes the packaged tree mirror the repository, so the path
*below* the root is the same string in both builds and anything added to
`resources/` later ships without touching `electron-builder.yml` again. The
alternative — `from: resources/skills, to: skills` — is one directory shallower
and has to be extended for every new kind of shipped resource.

Only `src/main/index.ts` may ask electron where anything is (CLAUDE.md rule #5),
which is why this lives there and not in `skills/loader.ts`. The loader takes a
directory; see [`../skills/backend.md`](../skills/backend.md),
"First-launch seeding".

## Database

None. Packaging reads and writes no table and adds no migration. It does decide
where the **driver** comes from — `app.asar.unpacked/node_modules/better-sqlite3`
— and the migrations are already string literals inside `out/main/index.js`, so
there is nothing on disk for the build to copy. See
[`../database/backend.md`](../database/backend.md).

## IPC handlers

| Channel | Input | Output | Errors |
|---|---|---|---|
| — | — | — | None added |

## Events emitted

| Event | Payload | Emitted when |
|---|---|---|
| — | — | None added |

## Filesystem

Inside the bundle:

```
Witena.app/Contents/
  MacOS/Witena                                  the executable Playwright launches
  Resources/
    app.asar                                    out/** + package.json + prod node_modules
    app.asar.unpacked/
      node_modules/better-sqlite3/**            the native module, dlopen-able
    resources/skills/architecture-review/       extraResources
    icon.icns
```

Outside it, unchanged: the app still writes only to `app.getPath('userData')` —
`witena.db`, `skills/`, `memory/` — and the `WITENA_USER_DATA` override still
works in a packaged build, which is what lets `e2e/packaged.spec.ts` run against
a throwaway directory.

## The unsigned caveat

The dmg is **not signed with a Developer ID and not notarized**. There is no
Apple Developer certificate behind this repository, and a signature cannot be
faked.

To be exact about what `identity: null` does: electron-builder skips its own
signing step ("skipped macOS code signing — reason=identity explicitly is set to
null"), and the bundle keeps the **ad-hoc, linker-signed** signature the Electron
binary already carries — `codesign -dv` reports `Identifier=Electron`,
`flags=0x20002(adhoc,linker-signed)`. That satisfies the arm64 loader, which
refuses an entirely unsigned Mach-O, and it does **not** satisfy Gatekeeper,
which wants a Developer ID and a notarization ticket.

What a user sees: macOS refuses the first double-click ("Witena is damaged", or
"cannot be opened because the developer cannot be verified", depending on the
version). The way through is **right-click → Open**, then confirm in the dialog.
That records an exception for the bundle and every later launch is ordinary.
`xattr -dr com.apple.quarantine /Applications/Witena.app` does the same thing
from a terminal. Both are in the README, because a user who does not know this
concludes the app is broken.

Removing the caveat is a purchase, not a code change: a Developer ID certificate,
`hardenedRuntime: true`, `identity` set to the certificate name, and the
`notarize` block with an App Store Connect key.

## Building the icon

Covered step by step in [`implement.md`](./implement.md). The short version:
`build/icon.svg` is rasterised to 2048 px by loading it in a transparent
Electron window and writing `webContents.capturePage()`, downsampled to 1024 px
with `sips`, expanded into `build/icon.iconset/` at the five sizes plus their
`@2x` variants, and packed with `iconutil -c icns`.

The 64 px inset in the SVG is the padding macOS expects around an app icon — an
icon drawn edge to edge looks oversized next to every other one in the Dock —
and the 76 px stroke on the "W" is what keeps the mark legible at the 16 px
variant.

## How to release

See [`implement.md`](./implement.md), "Making a release". In short: run the
existing gate (`npm run typecheck && npm test && npm run e2e`), `npm run dist`,
mount the dmg, copy `Witena.app` off it, detach, and run `npm run e2e:packaged`
against the copy. Then `hdiutil info` to confirm no volume of ours is still
mounted.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `electron-builder` | The whole build | It runs `@electron/rebuild` itself before packaging, and warns that the project's own `@electron/rebuild` devDependency is redundant — **it is not**: `npm install`'s `postinstall` needs it to make `npm run dev` and `npm run e2e` work, long before any packaging happens. It also warns about a missing `author` in `package.json`; harmless for an unsigned local build. An `npm install --ignore-scripts` skips the `postinstall` rebuild, and electron-builder's own rebuild then fixes the module for the *bundle* but not for the checkout — run `npx electron-rebuild -f -w better-sqlite3` if `npm run dev` stops loading the database afterwards |
| `dmgbuild` (vendored by electron-builder) | The disk image | Downloaded on the first `--mac` run, so the first build is several minutes slower than the rest and needs the network |
| `sips`, `iconutil` (macOS) | PNG scaling and the icns | `sips -z H W` takes **height first**. `iconutil` refuses an iconset that is missing any of the ten expected names, and the names are exact: `icon_16x16@2x.png`, not `icon_32x32.png` under a different name |
| `ffmpeg` | The demo GIF | `palettegen` / `paletteuse` must be two passes over the *same* filtered frames, or the palette describes footage that is not what gets encoded. This build of ffmpeg has no `drawtext` filter, so frame-timestamp overlays are not available while inspecting a recording — use `tile` contact sheets and arithmetic instead |
| Playwright `_electron.launch` | Both extra specs | `executablePath` plus an empty `args` is how a *packaged* app is launched; the `args: ['.']` every other spec uses points electron at a project directory and is wrong for a bundle. `recordVideo` on the launch options records the window, and `page.video().path()` only resolves after the context has closed |
