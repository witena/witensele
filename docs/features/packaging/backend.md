# packaging — Backend

## Modules

| File | Responsibility |
|---|---|
| `electron-builder.yml` | The whole build configuration: app id, product name, file selection, asar unpacking, extra resources, the macOS target and the signing decision |
| `build/icon.svg` | The mark: the Aperture — six near-black blades closing on a terracotta point inside an eased hexagon, on a white rounded tile (S7.1) |
| `build/icon-dark.svg` | The same geometry on an ink tile with white blades. **Not** the shipped icon; kept for the README and other dark surfaces |
| `build/icon.png` | The 1024 px rasterisation of it, and the only input to the iconset |
| `build/icon.icns` | What `mac.icon` points at. Binary, committed, regenerated only when the mark changes |
| `build/icon.iconset/` | The ten intermediate PNGs `iconutil` reads. **Gitignored** — derived and reproducible in one loop |
| `src/main/index.ts` | `bundledSkillsDir()`: the only runtime code that behaves differently in a packaged build |
| `playwright.packaged.config.ts` | Runs `e2e/packaged.spec.ts` and nothing else |
| `e2e/packaged.spec.ts` | The acceptance test against the shipped bundle |
| `playwright.demo.config.ts`, `e2e/demo.record.ts` | The tour recording that produces `docs/assets/` |
| `.github/workflows/ci.yml` | The gate on every push and pull request, plus the `actionlint` job that lints both workflow files |
| `.github/workflows/release.yml` | A `v*` tag → checks → both dmgs → a draft GitHub Release |
| `scripts/sync-version.mjs` | Rewrites `APP_VERSION` from `package.json`; run by npm's `version` lifecycle during `npm version` |
| `scripts/generate-licenses.mjs` | **S7.5.** Writes `src/renderer/src/generated/licenses.json` (gitignored) from the production dependency tree, for Settings → About. Run by the `pretypecheck` / `pretest` / `predev` / `prebuild` hooks, so it happens before anything that reads the file — including `npm ci && npm run typecheck` on CI. Owned by [`../ui-shell/backend.md`](../ui-shell/backend.md); listed here because it is part of every build |
| `src/main/packaging.test.ts` | The unit test over `electron-builder.yml` and the two copies of the version number |
| `src/renderer/src/components/ui/brand-mark.test.ts` | The other half of the icon's gate: it proves `build/icon.svg` and the rail's inlined mark are the same drawing. Owned by [`../ui-shell/implement.md`](../ui-shell/implement.md); listed here because it is the only test that looks at `build/` at all |

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
| `mac.target` | `dmg`, `arch: [arm64, x64]` | Two dmgs, not a universal binary: each download is half the size, and the native module is per-architecture either way (PLAN.md, "Local release"). The zip target exists for auto-update, which does not exist yet (S7.4) |
| `mac.category` | `public.app-category.developer-tools` | `LSApplicationCategoryType` in the Info.plist |
| `mac.icon` | `build/icon.icns` | Copied to `Contents/Resources/icon.icns` |
| `mac.hardenedRuntime` | `false` | The hardened runtime is a notarization requirement; without a signature it only adds restrictions for nothing |
| `mac.identity` | `null` | No Developer ID signing. Explicit rather than omitted: without it electron-builder picks up whatever identity is in the building machine's keychain, which makes the artifact depend on who built it. See "The unsigned caveat" |
| `dmg.artifactName` | `${productName}-${version}-${arch}.${ext}` | `Witena-0.1.0-arm64.dmg` and `Witena-0.1.0-x64.dmg` — `${arch}` is what keeps two builds of one version from overwriting each other in `dist/` and in the Release |
| `publish.provider` | `github` | electron-builder uploads the artifacts itself and writes the `latest-mac.yml` feed S7.4 will read. `owner` / `repo` are deliberately absent: they are inferred from the checkout's git remote, so a tag pushed on a fork publishes to that fork |
| `publish.releaseType` | `draft` | The review step. CI packages; a human reads the artifacts and presses Publish |

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

Three things about that pipeline are load-bearing, and S7.1 is the step that
found out why:

- **The rasteriser has to be a real one.** `sips` converts images; it cannot
  render an SVG's curves. Chromium (the Electron binary in `node_modules`) draws
  the mark with Skia, which anti-aliases properly, and `shape-rendering="geometricPrecision"`
  on the `<svg>` root tells it not to snap the diagonals to the pixel grid. Every
  edge in this mark is a diagonal meeting another at a shallow angle, so that hint
  is the difference between a smooth blade and a staircase.
- **Every size below 1024 is a downscale, never a re-render.** Rendering directly
  at 32 px would anti-alias a 0.9 px stroke against nothing; downscaling a 1024 px
  bitmap with `sips -z` averages the supersampled pixels instead. The render
  itself is the same idea one level up: Chromium captures at 2048 on a Retina
  display and `sips` takes it to 1024.
- **The 16 px variant is drawn with a thicker stroke, and only that variant.**
  30 px on a 1024 canvas is 0.47 px at 16 — the blades average to a uniform grey
  and the mark becomes a smudge. It is re-rendered from the same `icon.svg` with
  `stroke-width` substituted to **56**, which is ~0.9 px at 16 and gives a legible
  dark aperture with the terracotta point still readable. 56 was picked by
  rendering 44 / 56 / 68 / 80 and looking at all four: 44 is still washed out and
  68 upwards closes the white gaps into a blob. Nothing else in the iconset is
  touched — 32 px and up are legible at the drawn weight — and the substitution is
  a `sed` over the committed SVG rather than a second committed file, so there is
  still exactly one drawing.

Each blade starts 16 px inside its hexagon corner, along its own direction,
rather than at the true vertex. The frame's corners are eased with a 52 px
radius, which pulls the frame's centreline about 8 px inside the vertex; a blade
that began at the vertex poked a few pixels past the rounded outline as a small
nub on every corner (seen in the first S7.1 render). 16 px puts the whole butt
end of the blade inside the frame's 30 px stroke band — no nub outside, no notch
inside — and `brand-mark.tsx` carries the same coordinates.

The 64 px inset in the SVG is the padding macOS expects around an app icon — an
icon drawn edge to edge looks oversized next to every other one in the Dock. The
tile carries **no border**: a hairline around a white tile is invisible on a light
Dock and a grey fuzz at 16 px, and the tile's own anti-aliased edge is one pixel
of partial alpha with no colour fringe (verified by reading the pixels either side
of x=64 in the 1024 px render).

## Continuous integration

`.github/workflows/ci.yml`, on every push and every pull request:

| Job | Runner | Steps |
|---|---|---|
| `check` | `macos-latest` | `npm ci`, `npm run typecheck`, `npm test`, `npm run build` |
| `actionlint` | `ubuntu-latest` | Downloads `actionlint` 1.7.12, checks its SHA-256, lints `.github/workflows/` |

macOS for the `check` job is not a preference: `postinstall` rebuilds
`better-sqlite3` against the Electron ABI and the artifact this repository
produces is a macOS bundle. A Linux runner would prove something about a
platform Witena is not shipped on.

`npm run e2e` is **not** part of CI — it needs a local Ollama. See
[`implement.md`](./implement.md), "What CI does not run".

`actionlint` is pinned by version *and* checksum and downloaded in a `run:`
step. An npm devDependency would put a workflow linter in the product's
dependency tree; a third-party action pinned by tag would trust a pointer
someone else can move.

## Publishing

`.github/workflows/release.yml`, on a `v*` tag: the same checks, then

```sh
npm run dist -- --publish always
```

`npm run dist` is `npm run build && electron-builder --mac`, and npm appends
what follows `--` to the end of that string, so the flag reaches
electron-builder. Both architectures come from `mac.target[0].arch` and are
built in **one** invocation deliberately: `latest-mac.yml` describes a release,
not an architecture, so two parallel jobs would each write a feed naming only
their own dmg and the second upload would win.

What lands in the draft Release: `Witena-<version>-arm64.dmg`,
`Witena-<version>-x64.dmg`, a `.blockmap` beside each, and `latest-mac.yml`.
The upload is electron-builder's own GitHub publisher rather than a separate
upload action, because the feed and the blockmaps are things the builder
computes while it packages; regenerating them in a later step would be a second
implementation of a fact it already knows, and S7.4's `electron-updater` reads
exactly that feed.

Authentication is `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` plus
`permissions: contents: write` on the job. No personal token is involved.

### The signing gate (S7.3 adds secrets, not workflow steps)

The `secrets` context is **not** available to an `if:` expression — not at job
level and not at step level — so `if: ${{ secrets.CSC_LINK != '' }}` is not a
condition that can work. The workflow reads the secret into `env` in a step
that is allowed to see it and publishes the *answer* as a step output:

```yaml
- name: Decide whether this build can be signed
  id: signing
  env:
    CSC_LINK: ${{ secrets.CSC_LINK }}
  run: |
    if [ -n "${CSC_LINK:-}" ]; then
      echo 'enabled=true' >> "$GITHUB_OUTPUT"
    else
      echo 'enabled=false' >> "$GITHUB_OUTPUT"
    fi
```

`steps.signing.outputs.enabled` then gates the `codesign --verify --deep
--strict` / `spctl --assess` verification, and it is also what
`CSC_IDENTITY_AUTO_DISCOVERY` is set to — false on an unsigned build, so
electron-builder cannot quietly sign with whatever identity a runner's keychain
happens to hold. The `CSC_*` and `APPLE_*` secrets are passed to the packaging
step unconditionally; absent, they arrive as empty strings and are ignored.

What S7.3 still has to change is `electron-builder.yml` — `identity`,
`hardenedRuntime: true`, an entitlements file and a `notarize` block — and the
README's Gatekeeper note. Not this workflow.

## Cutting a release

`npm version <patch|minor|major>` bumps `package.json`, commits and tags.
Two npm lifecycle scripts hang off it:

| Script | When | What |
|---|---|---|
| `preversion` | Before the bump | `npm run typecheck && npm test` — a tag is not worth creating if the suite is red |
| `version` | After the bump, before npm's commit | `node scripts/sync-version.mjs && git add src/shared/version.ts` |

`APP_VERSION` in `src/shared/version.ts` is a second copy of the version number
(`src/shared/` is imported by main, preload and renderer, so reading
`package.json` there would pull the manifest into every bundle), and
`src/main/mcp/manager.ts` sends it to every MCP server in the client handshake.
The `version` script rewrites it and stages it so the tagged commit carries both
copies; `src/main/packaging.test.ts` fails if they ever disagree.

Then `git push --follow-tags`, wait for the draft, publish it. The full
procedure, including verifying the uploaded dmg with `npm run e2e:packaged`, is
in [`implement.md`](./implement.md), "Making a release".

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `electron-builder` | The whole build | It runs `@electron/rebuild` itself before packaging, and warns that the project's own `@electron/rebuild` devDependency is redundant — **it is not**: `npm install`'s `postinstall` needs it to make `npm run dev` and `npm run e2e` work, long before any packaging happens. It also warns about a missing `author` in `package.json`; harmless for an unsigned local build. An `npm install --ignore-scripts` skips the `postinstall` rebuild, and electron-builder's own rebuild then fixes the module for the *bundle* but not for the checkout — run `npx electron-rebuild -f -w better-sqlite3` if `npm run dev` stops loading the database afterwards |
| `dmgbuild` (vendored by electron-builder) | The disk image | Downloaded on the first `--mac` run, so the first build is several minutes slower than the rest and needs the network |
| `sips`, `iconutil` (macOS) | PNG scaling and the icns | `sips -z H W` takes **height first**. `iconutil` refuses an iconset that is missing any of the ten expected names, and the names are exact: `icon_16x16@2x.png`, not `icon_32x32.png` under a different name |
| `ffmpeg` | The demo GIF | `palettegen` / `paletteuse` must be two passes over the *same* filtered frames, or the palette describes footage that is not what gets encoded. This build of ffmpeg has no `drawtext` filter, so frame-timestamp overlays are not available while inspecting a recording — use `tile` contact sheets and arithmetic instead |
| GitHub Actions (`actions/checkout@v4`, `actions/setup-node@v4`) | CI and release | Pinned to major tags. `setup-node`'s `cache: npm` needs `package-lock.json`, which is committed. `npm ci` runs the `postinstall` electron-rebuild, which downloads the Electron binary — the slow step of every job |
| `actionlint` 1.7.12 | Linting the workflows | Pinned by version and SHA-256 of the release tarball. On a runner with `shellcheck` installed — the Ubuntu images have it — it also lints every `run:` block, so findings can appear in CI that a local run without shellcheck does not report |
| Playwright `_electron.launch` | Both extra specs | `executablePath` plus an empty `args` is how a *packaged* app is launched; the `args: ['.']` every other spec uses points electron at a project directory and is wrong for a bundle. `recordVideo` on the launch options records the window, and `page.video().path()` only resolves after the context has closed |
