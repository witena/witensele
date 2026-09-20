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
| `build/entitlements.mac.plist` | **S7.3.** The hardened runtime's exceptions, for the app and (through `entitlementsInherit`) its helpers. Two keys, each justified in the file itself |
| `src/main/index.ts` | `bundledSkillsDir()` and `signedBuild()`: the only runtime code that behaves differently in a packaged build |
| `playwright.packaged.config.ts` | Runs `e2e/packaged.spec.ts` and nothing else |
| `e2e/packaged.spec.ts` | The acceptance test against the shipped bundle |
| `playwright.demo.config.ts`, `e2e/demo.record.ts` | The tour recording: films the built app over CDP `Page.startScreencast` into `test-results/demo/` |
| `scripts/render-demo.mjs` | Renders those frames into `docs/assets/demo.mp4`, `demo.gif` and `features/*.gif` with ffmpeg |
| `.github/workflows/ci.yml` | The gate on every push and pull request, plus the `actionlint` job that lints every workflow file |
| `.github/workflows/release.yml` | A `v*` tag → checks → both dmgs → a draft GitHub Release |
| `.github/workflows/auto-merge.yml` | A pull request the owner opens → GitHub's auto-merge flag → merged when the required checks pass. Guarded to same-repository, non-draft, owner-authored pull requests |
| `.github/workflows/sweep-merged-branches.yml` | Hourly, or by hand: deletes a branch whose merged pull request left it behind. Needed because `delete_branch_on_merge` does not fire for a merge `GITHUB_TOKEN` performs |
| `scripts/sync-version.mjs` | Rewrites `APP_VERSION` from `package.json`; run by npm's `version` lifecycle during `npm version` |
| `scripts/generate-licenses.mjs` | **S7.5.** Writes `src/renderer/src/generated/licenses.json` (gitignored) from the production dependency tree, for Settings → About. Run by the `pretypecheck` / `pretest` / `predev` / `prebuild` hooks, so it happens before anything that reads the file — including `npm ci && npm run typecheck` on CI. Owned by [`../ui-shell/backend.md`](../ui-shell/backend.md); listed here because it is part of every build |
| `scripts/fetch-ant.mjs`, `build/ant-release.json` | Downloads the Anthropic CLI the bundle ships, for both architectures, into the gitignored `vendor/ant/<arch>/`; refuses an archive whose SHA-256 is not the pinned one. `npm run ant:fetch`. `predev` / `prebuild` pass `--optional` (a failure is a warning, the app falls back to an installed `ant`); `predist`, `predist:signed` and `predist:dir` do not, so a dmg cannot be built without it. Upgrading `ant` is an edit to the JSON: version, two file names, two checksums, all from the release's Homebrew cask |
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
| `extraResources` (second entry) | `vendor/ant/${arch}` → `bin`, filtered to `ant`; plus `build/ant.LICENSE` → `bin/ant.LICENSE` | The Anthropic CLI, so Sign in opens a browser on a machine that never installed it. `${arch}` gives each dmg its own architecture's binary. `src/main/index.ts` hands `process.resourcesPath/bin` to the CLI wrapper, which searches it last — see [`../providers/backend.md`](../providers/backend.md) |
| `mac.target` | `dmg` and `zip`, both `arch: [arm64, x64]` | Two dmgs, not a universal binary: each download is half the size, and the native module is per-architecture either way (PLAN.md, "Local release"). The **zip is S7.4's** and is not a second download offered to anyone: macOS's `Squirrel.Mac` replaces a bundle from a zip and nothing else, and `latest-mac.yml` lists whatever targets were built — a release with only a dmg is a feed the updater downloads and then cannot apply |
| `mac.category` | `public.app-category.developer-tools` | `LSApplicationCategoryType` in the Info.plist |
| `mac.icon` | `build/icon.icns` | Copied to `Contents/Resources/icon.icns` |
| `mac.hardenedRuntime` | `true` (S7.3) | Notarization refuses a bundle that is not hardened. It costs an unsigned build nothing, because the flag is only ever written by `codesign`, which does not run without an identity |
| `mac.identity` | **absent** (S7.3) | Not `null` and not a name. Its absence is what makes one configuration produce both builds: electron-builder looks for a Developer ID Application certificate in the keychain, signs with it if there is one, and logs `skipped macOS application code signing` if there is not. `null` would mean "never sign"; a name would tie the file to one developer's keychain |
| `mac.entitlements`, `mac.entitlementsInherit` | `build/entitlements.mac.plist` | The hardened runtime's two exceptions, for the app and for its helper processes. See "The entitlements" |
| `mac.gatekeeperAssess` | `false` | electron-builder's default, spelled out because the alternative is a trap: `spctl --assess` **during** packaging fails on a bundle that is correctly signed but not yet notarized, which is every bundle at the moment it is built. Gatekeeper is checked afterwards instead |
| `mac.notarize` | `true` | A boolean in electron-builder 26 — there is no sub-object. It means "do not disable the built-in @electron/notarize integration"; the credentials are environment variables and never live in this repository. With none of them set the build logs `skipped macOS notarization` and succeeds |
| `dmg.artifactName` | `${productName}-${version}-${arch}.${ext}` | `Witena-0.1.0-arm64.dmg` and `Witena-0.1.0-x64.dmg` — `${arch}` is what keeps two builds of one version from overwriting each other in `dist/` and in the Release |
| `publish.provider` | `github` | electron-builder uploads the artifacts itself and writes the `latest-mac.yml` feed S7.4's `electron-updater` reads. `owner` / `repo` are deliberately absent: they are inferred from the checkout's git remote, so a tag pushed on a fork publishes to that fork. The block is also copied verbatim into the bundle as `Contents/Resources/app-update.yml`, which is why it must never gain a `token:` — see "Auto-update" |
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

### The shipped `ant` and the signature

`bin/ant` is a Mach-O executable inside `Contents/`, so `@electron/osx-sign`
signs it with the app's identity, hardened runtime and entitlements, replacing
whatever signature the release archive carried; notarization then covers it
with the rest of the bundle. It is fetched with Node's `fetch`, which sets no
`com.apple.quarantine` attribute, so the `xattr -d` step a Homebrew install
needs does not apply. **Not yet verified on a signed, notarized build**: that a
Go binary launches under the app's entitlements, and that `codesign --verify
--deep --strict` still passes. Check both the first time `npm run dist:signed`
runs with this entry.

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
    bin/ant                                     extraResources, this arch's Anthropic CLI
    bin/ant.LICENSE                             its MIT notice; committed as build/ant.LICENSE, the archive has none
    icon.icns
```

Outside it, unchanged: the app still writes only to `app.getPath('userData')` —
`witena.db`, `skills/`, `memory/` and, since S7.6, `secrets.key` — and the
`WITENA_USER_DATA` override still works in a packaged build, which is what lets
`e2e/packaged.spec.ts` run against a throwaway directory.

## Signing and notarization

Since S7.3 **one configuration produces two builds**, and which one you get
depends entirely on what the machine has, never on an edit here.

| The machine has | What electron-builder does | What `codesign -dv` reports |
|---|---|---|
| A Developer ID Application certificate **and** notarization credentials | Signs, hardens, notarizes, staples | `Authority=Developer ID Application: …`, `flags=0x10000(runtime)` |
| A certificate but no credentials | Signs and hardens; logs `skipped macOS notarization` | The same, without a ticket — Gatekeeper still refuses it |
| Neither | Logs `skipped macOS application code signing … 0 identities found`; the bundle keeps the **ad-hoc, linker-signed** signature the Electron binary already carries | `Identifier=Electron`, `flags=0x20002(adhoc,linker-signed)`, `TeamIdentifier=not set` |

The third row is what this repository produces today and is unchanged from
S4.4 — verified by building it. That matters more than it sounds: removing
`identity: null` could have made an unsigned build *fail* rather than skip, and
it does not. Two independent reasons it cannot:

- `findSigningIdentity` reports "no identity" as a **warning** and returns null
  unless `forceCodeSigning` is set, which this project never sets.
- `notarizeIfProvided` is only reached **after** a successful signature, and it
  skips itself again when no credential variable is set. Notarization therefore
  cannot fire on a build that was not signed, whatever is in the environment.

The ad-hoc signature satisfies the arm64 loader, which refuses an entirely
unsigned Mach-O, and does **not** satisfy Gatekeeper, which wants a Developer ID
and a notarization ticket.

What a user sees when they build their own dmg: macOS refuses the first
double-click ("Witena is damaged", or "cannot be opened because the developer
cannot be verified", depending on the version). The way through is **right-click
→ Open**, then confirm in the dialog; that records an exception for the bundle
and every later launch is ordinary. `xattr -dr com.apple.quarantine
/Applications/Witena.app` does the same from a terminal. Both are in the README,
because a user who does not know this concludes the app is broken. A user who
downloads a **released** dmg sees none of it.

### Where a signed build may be staged

`codesign` refuses any file that carries a resource fork or Finder information,
and macOS's File Provider adds exactly those extended attributes to everything
under an iCloud "Desktop & Documents" folder. A checkout in `~/Documents` on
such a machine therefore signs nothing: the first S7.3 attempt failed on
`Witena Helper (GPU)` with "resource fork, Finder information, or similar
detritus not allowed". An unsigned build never runs `codesign`, which is why
S4.4–S7.2 never met it. `npm run dist:signed` stages and writes its output in
`${WITENA_DIST_DIR:-$HOME/Library/Caches/witena-dist}`, which no sync provider
manages; `npm run dist` (unsigned) still writes to `dist/`. CI is unaffected —
a runner's checkout is on a plain volume.

### What the first signed build measured (2026-09-17)

| Check | Result |
|---|---|
| `spctl -a -vv` on both `.app`s | `accepted`, `source=Notarized Developer ID` |
| `xcrun stapler validate` | passes for both |
| `codesign --verify --deep --strict` on the installed app | passes |
| Native module under the hardened runtime | `prebuilds/darwin-arm64.node` loads, the database opens |
| Entitlements actually needed | `allow-jit`, `allow-unsigned-executable-memory`; not `disable-library-validation` |
| Notarization latency | 55 min for the account's first submission, 5 min for the second |
| `secrets.key` on the first signed run | `fkkey1:` → `fkkey1w:`, mode `0600`, provider ciphertexts unchanged |

### The entitlements

`build/entitlements.mac.plist`, used for the app and — through
`entitlementsInherit` — for every helper process. It grants two things:

| Entitlement | Why |
|---|---|
| `com.apple.security.cs.allow-jit` | V8 compiles JavaScript to machine code at runtime. Without it the renderer cannot allocate MAP_JIT pages and Electron does not start on arm64 |
| `com.apple.security.cs.allow-unsigned-executable-memory` | The other half of the same requirement, named by @electron/notarize's prerequisites: V8 writes into pages it then executes |

It is **shorter than both defaults it replaces**. @electron/osx-sign's
`default.darwin.plist` also asks for the camera, the microphone, Bluetooth, USB,
the printer and the user's location — Witena touches none of them, and an
entitlement that is requested but unused is a permission prompt waiting to
surprise somebody. app-builder-lib's own template, which is what a build with no
`entitlements` option gets, carries a third key:

**`com.apple.security.cs.disable-library-validation` is deliberately absent.**
Library validation only rejects code signed by a *different* team. The one native
library Witena `dlopen`s — `better_sqlite3.node`, unpacked out of the asar
because `dlopen` takes a filesystem path — is signed by this build with this
project's own identity, because @electron/osx-sign walks `Contents/` and signs
every Mach-O file it finds there, `.node` bundles included, before the outer
bundle is sealed. Same team, so validation passes and the exception would buy
nothing while widening what the app is allowed to load.

That is **reasoning, not an observation**, and it is the one claim on this page
that a certificate could overturn. If the first signed build fails to open its
database on launch — a `Library not loaded` or `code signature` error naming
`better_sqlite3.node` — the fix is to add the key to the plist and rebuild.
Nothing else about the configuration changes. The file says so in its own
comment, so whoever hits it does not have to find this page first.

### Notarization credentials

electron-builder's built-in @electron/notarize integration reads them from the
environment, in this order, and never from a file:

| Form | Variables | Used by |
|---|---|---|
| Keychain profile | `APPLE_KEYCHAIN_PROFILE` (plus `APPLE_KEYCHAIN` for a non-default keychain) | The local signed build. The profile is created once with `xcrun notarytool store-credentials` and the password never leaves the Keychain |
| Apple ID | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | CI, from GitHub secrets |
| App Store Connect key | `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Neither today. It is the form electron-builder recommends, and the upgrade path if the app-specific password becomes awkward |

A partial set is an **error**, not a skip: setting `APPLE_ID` without
`APPLE_APP_SPECIFIC_PASSWORD` fails the build with `APPLE_APP_SPECIFIC_PASSWORD
env var needs to be set`. That is the right behaviour — a release that quietly
skipped notarization would be discovered by a user, not by the build.

### What being unsigned does to the stored secrets (S7.6)

### What being unsigned does to the stored secrets (S7.6)

The caveat is not only a Gatekeeper dialog. macOS grants the `safeStorage`
Keychain item ("Witena Safe Storage") **per application identity**, and an
unsigned bundle's identity is whatever this particular packaging run produced —
so the next dmg is, as far as the Keychain is concerned, a different application.
That is not theoretical: when the S7.1 dmg replaced the S4.4 one, every provider
key already in the user's database (`v10…`, genuine `safeStorage` ciphertext)
became undecryptable, and the app reported it as "no key" and a failed probe.

S7.6's answer is to stop keying the secrets off the bundle at all. The
encryption key is 32 random bytes in `userData/secrets.key` (mode `0600`,
created on first use), provider keys are AES-256-GCM under it, and a startup
pass re-encrypts anything still in the old format — leaving a row it cannot read
untouched and explaining it in the UI. The file is part of the user's data, so
an update, a reinstall and a rebuild all leave it alone.

**The security posture, stated exactly.** On an unsigned build the key file is
plain on disk: anyone who can read the user's home directory can read it and
every API key it protects. That is the same class of exposure the Keychain item
of an *unsigned* app already had — it is granted to an identity nothing vouches
for — and it buys the property the Keychain could not give: the keys survive the
next build. It is a deliberate trade, not an oversight, and it is documented in
`docs/features/providers/context.md` as well as here.

**Signing turns the wrapper on (S7.3).** On a signed build the key file is stored
**wrapped** by `safeStorage` instead of plain — the Keychain protects the key
file, and because the build is signed the identity it is granted to stops
changing between releases. Nothing else about the secret path changes: the same
`fk1:` ciphertext, the same column, the same migration. Wrapping stays off
otherwise, precisely because doing it on an unsigned build would recreate the bug
S7.6 fixed.

S7.6 left two things for S7.3 to finish, and S7.3 did both:

**1. The flag now reaches the packaged app.** S7.6 read the environment variable
`WITENA_SIGNED_BUILD`, and recorded in its own `Done:` paragraph that this could
not work: a variable exported while the dmg is being built is not in the
environment of the app a user double-clicks three days later, so the flag was
false exactly where it had to be true. It is now a field in the application's own
manifest:

```
electron-builder  -c.extraMetadata.witenaSignedBuild=true
                    ↓  writes it into the package.json inside the bundle
src/main/index.ts   signedBuild()  reads app.getAppPath()/package.json
                    ↓  a boolean
src/main/secrets.ts createFileKeySecretStore({ wrap })   (Electron-free)
```

`isSignedBuild` takes the **parsed manifest**, not a path and not an environment:
it stays a pure function that a test calls with a literal, and the one file
allowed to ask electron where the bundle is does the asking. In a checkout
`app.getAppPath()` is the repository root, whose `package.json` has no such
field, so development and the end-to-end harness are correctly "not signed". Any
failure to read it is also "not signed", because the cost of guessing wrong in
the other direction is a key file wrapped by a Keychain item granted to an
identity nothing vouches for.

The flag is passed by `npm run dist:signed` and by the release workflow **only
when the certificate exists**; `npm run dist` and `npm run dist:dir` never pass
it, and `src/main/packaging.test.ts` asserts that.

**2. An existing plain key file is re-wrapped, once.** `rewrapKeyFile`
(`src/main/secrets.ts`, called from `index.ts` before the store is built) takes a
`fkkey1:` file on a signed build and rewrites it as `fkkey1w:`. The distinction
that makes doing it silently defensible is that it **rewrites the container, not
the contents**: the same 32 bytes go back in, so every `fk1:` ciphertext in the
database stays readable and no provider key is re-encrypted or touched. What S7.6
declined to do without asking — re-encrypting the user's secrets — is still not
done.

| Case | Result |
|---|---|
| Unsigned build | No-op. Wrapping there is the original bug |
| No key file yet | No-op; the store creates one already wrapped |
| Already `fkkey1w:` | No-op — every launch after the first |
| `fkkey1:`, wrapper succeeds | Rewritten atomically: temp file in the same directory, `fsync`, `rename`, mode `0600` |
| Wrapper refuses, or the file is not ours | The plain file stands, one warning is logged, the temp file is removed |

The atomicity is not decoration. The interruption this has to survive is the one
that would be catastrophic — a half-written key file is every API key the user
has, gone — so the `rename` is the only moment anything observable changes, and
POSIX makes that indivisible within a filesystem. The failure path is equally
deliberate: `safeStorage` can refuse (a locked keychain, a user who clicked Deny)
and the honest answer is to keep the plain file, which still works, rather than
leave the user with a key nobody can read.

**Not yet observed on a real signed build.** The three cases are unit-tested with
a fake wrapper; the real `safeStorage` on a real Developer ID bundle has never
run. See STEPS.md S7.3.

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

**The runner uses the developer's npm (11.5.1), on purpose.** A lock file written
by npm 11.5 leaves out the optional subtree of a package it does not install on
macOS, and a newer npm's `npm ci` rejects that lock outright. Until the pin,
every pull request that added a dependency failed at `npm ci` and had its lock
regenerated by hand with a newer npm. Both workflows now install npm 11.5.1
before `npm ci`; a lock written by a newer npm is a superset and is accepted
too. Bump the pin when the local toolchain moves.


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

## Merging a pull request

`.github/workflows/auto-merge.yml` turns on GitHub's **auto-merge** for a pull
request the owner opens (`opened`, `reopened`, `ready_for_review`), with one
step:

```sh
gh pr merge --auto --merge "$PR_URL"
```

That is a flag, not a merge: GitHub performs the merge when `main`'s required
status checks have passed, and leaves the pull request open when they have not.
The workflow waits for nothing, reads no run and re-runs no check — everything
about *which* checks matter lives in the branch protection settings, not in the
file.

Half of this feature is therefore repository configuration rather than code,
and it is written down here because nothing in the repository can assert it:

| Setting | Value | Why |
|---|---|---|
| `allow_auto_merge` | `true` | `gh pr merge --auto` fails outright without it |
| `delete_branch_on_merge` | `true` | The merged branch is cleaned up by GitHub instead of by hand — **for a merge a person performs only**; see "Deleting the merged branch" below |
| Merge methods | Unchanged (merge, squash and rebase all allowed) | This history is made of merge commits, which is why the workflow passes `--merge` |
| Branch protection on `main` | Required status checks `check` and `actionlint`, `strict: false`, `enforce_admins: false`, no required reviews, no push restrictions, force pushes and deletions refused | The required checks are what hold a queued merge back; without protection auto-merge has nothing to wait for. Admins are exempt so the maintainer can still push a fix directly, and reviews are not required on a repository with one maintainer |

The two job names in that list are the jobs in `ci.yml` — rename a job there and
the protection rule has to be renamed with it, or every pull request waits for a
check that no longer reports.

**Security.** The repository is public, so the guards are the point:

- The workflow runs on `pull_request`, never `pull_request_target`. The latter
  would run this file from the base branch with a **writable** token for a pull
  request opened from any fork, which for a workflow whose job is to merge is
  the whole farm given away. Under `pull_request` a fork's run gets a read-only
  token.
- A job-level `if:` requires all three of: the head branch is in this repository
  (not a fork), the pull request is not a draft, and the author is the owner's
  login. The login is hard-coded because `github.repository_owner` is the
  organisation name, not a person, and no expression context answers "may this
  account merge here".
- `permissions:` is `contents: write` and `pull-requests: write`, nothing else,
  and the job checks nothing out and uses no third-party action — its whole
  supply chain is the `gh` CLI preinstalled on the runner.

`src/main/packaging.test.ts` asserts each of those, because `actionlint` proves
the file is a valid workflow and cannot prove that the guards still say what
they said.

**A `pull_request` workflow runs from the head branch**, so a pull request that
edits `auto-merge.yml` runs its edited copy — the pull request that introduced
the file enabled auto-merge on itself as soon as it was opened, and it had to
be turned off by hand for review. This is not a way in: a fork's run of an
edited copy still gets a read-only token and still fails the guards before the
step executes. It is worth knowing about when changing the file, because the
change takes effect on the pull request proposing it.

**What this costs: `main` gets no `push` run of its own.** A merge performed
with `GITHUB_TOKEN` does not trigger further workflow runs, so the `ci.yml`
build an ordinary push to `main` produces does not happen for a merge this
workflow queued. What was tested is the pull request's own run — and with
`strict: false`, that run tested the merge candidate only while the branch was
up to date with `main`; a branch that has fallen behind is merged on the
strength of a run that never saw the commits it is merged with. `strict: true`
would fix it by making every pull request rebase and re-run the macOS gate each
time `main` moved, which on a single-maintainer repository buys serialisation
nobody needs. The next pull request's run is what notices a bad interaction.

### Deleting the merged branch

`delete_branch_on_merge` does not fire when the merge was performed with
`GITHUB_TOKEN`, which is every merge `auto-merge.yml` queues, and no workflow
can react to such a merge (the rule above). `.github/workflows/sweep-merged-branches.yml`
runs on `schedule` (`17 * * * *`) and `workflow_dispatch` instead, with
`contents: write` and `pull-requests: read`, no checkout and no action:

```sh
gh api "repos/$REPO/branches" --paginate   # unprotected, not the default branch
gh pr list --state merged --head "$name"   # headRefOid == the branch's sha, owner == this repository's
gh pr list --state open   --head "$name"   # must be empty
gh api -X DELETE "repos/$REPO/git/refs/heads/$name"
```

| Condition | Why |
|---|---|
| Unprotected and not the default branch | `main` is both; either alone would do |
| A merged pull request had this head, **at this commit**, from this repository's owner | `--head` matches by name, so a fork's branch of the same name would match; and a branch pushed to after its merge holds commits `main` does not |
| No open pull request from it | A branch reused for a second pull request is still in use |

Both triggers run the default branch's copy of the file, so nothing a pull
request contains can change what the sweep does until that pull request has
merged. To run it now: `gh workflow run sweep-merged-branches.yml`.

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

**The workflow creates the draft; electron-builder only fills it.** The
publisher uploads artifacts in parallel, and each uploader that finds no Release
for the tag creates one. The first run that reached the upload (2026-09-20) left
**two** drafts named `0.1.0`, created in the same second — eight files in one and
`Witena-0.1.0-arm64-mac.zip.blockmap` alone in the other; the blockmap was copied
across by hand. "Create the draft Release the artifacts will be uploaded to" now
runs `gh release create --draft --verify-tag` before packaging (and
`--prerelease` for a nightly tag), so every uploader finds the same existing
draft; if a Release for the tag is already there — a re-run — it is reused.
`src/main/packaging.test.ts` asserts the step and that it precedes packaging.

### The signing gate, and who imports the certificate

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
happens to hold. The `APPLE_*` secrets are passed to the packaging step unconditionally; absent,
they arrive as empty strings and notarization is skipped. **`CSC_LINK` and
`CSC_KEY_PASSWORD` are not passed to it at all**, and the certificate is imported
by a step of the workflow's own. Both halves come from failed `v0.1.0` runs on
2026-09-19:

| Run | What electron-builder did with `CSC_LINK` | Error |
|---|---|---|
| The secret existed but was **empty** | It tests `cscLink == null`, so `''` was resolved as a path against the project directory | `<project dir> not a file`, before anything was packaged |
| The secret held the real `.p12` | It created a keychain with a random password, imported the `.p12`, then ran `security set-key-partition-list … -k <the .p12's password>` — `-k` wants the **keychain's** password (`app-builder-lib/out/codeSign/macCodeSign.js`, `importCerts`, 26.15.3) | `SecKeychainUnlock: The user name or passphrase you entered is not correct` |

The second was reproduced off the runner with a throwaway self-signed `.p12` in
a temporary keychain: the partition list is refused with the `.p12`'s password
and accepted with the keychain's. A local `dist:signed` never reaches that code —
it signs from the login keychain — which is why S7.3's verification did not find
it.

So "Import the Developer ID certificate into a temporary keychain" decodes the
secret into `$RUNNER_TEMP`, creates a keychain with a password from
`openssl rand`, imports the `.p12` with `-T /usr/bin/codesign`, sets the
partition list with **that keychain's** password, prepends the keychain to the
user search list — the only place `CSC_IDENTITY_AUTO_DISCOVERY` looks — and
fails unless `security find-identity` then shows a `Developer ID Application`.
Before the check it also imports Apple's two Developer ID intermediates
(`DeveloperIDCA.cer`, `DeveloperIDG2CA.cer`, from
`apple.com/certificateauthority/`): a `.p12` exported from Keychain Access
carries the leaf and its key but not its issuer, and an identity whose chain
cannot be built is *imported* but not *valid*. The owner's certificate is issued
by the first-generation CA, which expires with it on **2027-02-01** — renewing
before then is a calendar item, not a code change. That check captures the listing and matches it with `case`; its first form piped
into `grep -q`, and under `set -o pipefail` that fails *because* it matched —
grep exits at the first hit, `security` dies of SIGPIPE, and the fifth `v0.1.0`
run stopped right after `1 identity imported.` with no message. The listing is
also printed, so "imported but not valid" (a missing intermediate) is
distinguishable from "not imported". A
`trap … EXIT` deletes the decoded `.p12`; the keychain dies with the runner.
`src/main/packaging.test.ts` asserts the packaging step's `env` names neither
variable, the two `security` invocations, the trap and the step order.

What S7.3 still has to change is `electron-builder.yml` — `identity`,
`hardenedRuntime: true`, an entitlements file and a `notarize` block — the
README's Gatekeeper note, and `WITENA_SIGNED_BUILD` reaching the packaged app so
the key file is wrapped (see "What being unsigned does to the stored secrets").
Not this workflow's structure.

## Auto-update (S7.4)

What the *build* has to produce, and what a *running* app does with it. The code
that consumes this — the Electron-free `src/main/updates/` and its
`electron-updater` adapter in `src/main/ipc/updater.ts` — is documented in
[`../backend-client/backend.md`](../backend-client/backend.md).

The build produces three things, and all three come from the `publish:` block:

| Artifact | Where | Read by |
|---|---|---|
| `Contents/Resources/app-update.yml` | Inside every bundle | `electron-updater` at startup, to learn which feed to ask. Written by electron-builder's `PublishManager` **only when a `dmg` or `zip` target is built** — a `--dir` build has no such file, and an app packaged that way reports `ENOENT … app-update.yml` the moment it tries to download |
| `Witena-<version>-<arch>-mac.zip` (+ `.blockmap`) | Beside the dmgs in the Release | `Squirrel.Mac`, which is the only thing that can replace a running `.app`. The blockmap is what makes the *next* update a differential download |
| `latest-mac.yml` | Beside them | `electron-updater`, to compare versions and to check the zip's sha512 |

### The GitHub feed, and what has been proven about it

`provider: github` means `electron-updater` asks
`https://github.com/<owner>/<repo>/releases/latest/download/latest-mac.yml`
unauthenticated. While the repository was private GitHub answered 404 to that
whatever the Release held; it is public as of 2026-09-19, and nothing in the
configuration had to change. A **draft** is invisible to that request, so the
feed exists from the moment a human publishes.

`v0.1.0` was published on 2026-09-20 and the feed was checked the way the updater
reads it — no token, plain `curl`:

| Request | Answer |
|---|---|
| `releases/latest/download/latest-mac.yml` | 200 after GitHub's redirect to `release-assets.githubusercontent.com`; names both zips and both dmgs with `sha512` and `size` |
| Both `-mac.zip.blockmap` files, both dmgs, the x64 zip (`HEAD`) | 200, with the `Content-Length` the manifest states |
| `Witena-0.1.0-arm64-mac.zip`, downloaded whole | 157 868 571 bytes; `openssl dgst -sha512 -binary \| base64` equals the manifest's `sha512` — the check `electron-updater` makes before it hands the zip to Squirrel |

**What that does not prove**: an update *applied* from GitHub. There is one
release, so every install is current; the first install of 0.1.0 that finds a
newer published version is the first real walk through download, validation and
restart against this feed (the local-feed walk below proved the mechanism). It
will also be a **full** download: `MacUpdater` does a differential one only when
the previous update's zip is cached as `update.zip`, and an install from a dmg
has none ("Unable to locate previous update.zip … is this first install?").
Differential downloads start with the second update, and they fetch the *old*
version's blockmap from its Release — deleting a published Release turns the
next update from it into a full download.

`electron-updater` supports a `token` in the publish configuration, and that was
never the way around the private phase: the configuration is copied verbatim
into `app-update.yml` **inside the dmg**, so a token there is a token handed to
everyone who downloads the app. `src/main/packaging.test.ts` still asserts the
`publish` block holds nothing but `provider` and `releaseType`.

### `WITENA_UPDATE_FEED`

The escape hatch, read once in `src/main/index.ts` and passed to
`createElectronUpdater`. It points the updater at a **generic** feed — a
directory over HTTP holding `latest-mac.yml` and the zip it names — and it also
lifts the packaged/signed gate, because its whole purpose is to run the updater
on a build that would otherwise refuse to look. It is a developer's environment
variable: nothing in the UI writes it, nothing reads it back, and an app the user
double-clicks has never seen it.

### Proving the whole path locally (done on 2026-09-17)

This is the procedure that produced the result recorded in STEPS.md S7.4. It
needs a Developer ID in the keychain — **not** notarization, which Squirrel does
not check — because macOS replaces an app bundle only when the new signature and
the old one match.

```sh
# A private electron-builder config whose publish block points at the local feed.
# It is what makes `app-update.yml` exist and name a generic provider.
sed 's/provider: github/provider: generic/; s/releaseType: draft/url: http:\/\/127.0.0.1:45999\//' \
  electron-builder.yml > "$TMP/eb-local.yml"

# The old version and the new one. `zip` rather than `--dir`: see the table above.
npm run build
npx electron-builder --mac zip -c "$TMP/eb-local.yml" \
  -c.extraMetadata.witenaSignedBuild=true -c.directories.output="$TMP/v1"
npx electron-builder --mac zip -c "$TMP/eb-local.yml" \
  -c.extraMetadata.witenaSignedBuild=true -c.extraMetadata.version=0.2.0 \
  -c.directories.output="$TMP/v2"

# The feed is what electron-builder already wrote beside the new zip.
cp "$TMP"/v2/Witena-0.2.0-arm64-mac.zip* "$TMP"/v2/latest-mac.yml "$TMP/feed/"
# Serve $TMP/feed on 127.0.0.1:45999 with **range requests supported** —
# Squirrel.Mac's proxy uses them, and a server that ignores `Range` hangs.

WITENA_USER_DATA=$TMP/userdata WITENA_UPDATE_FEED=http://127.0.0.1:45999/ \
  "$TMP/v1/mac-arm64/Witena.app/Contents/MacOS/Witena"
```

Two things worth knowing before repeating it. The downloaded zip is cached in
`~/Library/Caches/witena-updater/pending/`, so a second run finds it already
there and the feed server never sees a second request — delete that directory
between attempts or the run proves nothing. And `autoInstallOnAppQuit` is on, so
**quitting the app installs the update whether or not anybody pressed Restart**:
the v1 bundle is 0.2.0 afterwards and has to be rebuilt before the next attempt.

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

## Nightly builds

`scripts/nightly-tag.mjs` (`npm run nightly:tag`) is run once a day by a
scheduler on the owner's machine. It builds nothing: it decides whether
`origin/main` deserves a tag, pushes one, and `release.yml` does what it does for
any `v*` tag — sign, notarize, upload to a **draft**.

| Question | Answer |
|---|---|
| When does it tag? | When no `v*` tag — stable or nightly — points at `origin/main`'s commit, and today's nightly tag does not exist yet. Otherwise it prints why and exits 0 |
| What is the version? | `<next patch>-nightly.<yyyymmdd>` (UTC), from `package.json` **as it is on `origin/main`**: `0.1.0` → `0.1.1-nightly.20260920`. Semver puts that above 0.1.0 and below 0.1.1 |
| What does it commit? | Nothing. `main` is protected, and a bump commit a day is noise. The number exists only in the tag name; `release.yml`'s "Take the version from the tag" step runs `npm version <tag> --no-git-tag-version --ignore-scripts` and `node scripts/sync-version.mjs` in the runner's checkout, so `package.json` and `APP_VERSION` agree when the tests run |
| Does it touch the working tree? | No — `git fetch`, `git show origin/main:package.json`, `git tag <name> <sha>`. It is safe with any branch checked out and uncommitted work present |
| Why a machine and not a `schedule:` workflow? | A tag pushed with `GITHUB_TOKEN` triggers no workflow (the same rule that leaves `main` without a `push` run after an auto-merge), so a cron job inside Actions could not start `release.yml` this way. A person's credentials can |
| What about the drafts nobody publishes? | After pushing, it deletes nightly **drafts** beyond the newest three (`KEPT_NIGHTLY_DRAFTS`), with their tags. It never deletes a published release or a stable draft — `staleNightlyDrafts` filters on `isDraft` and the `-nightly.<8 digits>` suffix, and `src/main/nightly-tag.test.ts` pins both |

**The channel.** A pre-release version makes electron-builder write
`nightly-mac.yml` instead of `latest-mac.yml`, and `electron-updater` reads the
channel of the version it is running: a stable install never sees a nightly, and
a nightly install follows nightlies until a stable release with a higher version
arrives. Nothing in `src/main/updates/` had to change for that.

**The pre-release flag.** electron-builder creates the draft unflagged. Published
like that, GitHub would call a nightly the **latest** release, and every stable
install asks `releases/latest` for a `latest-mac.yml` that a nightly does not
contain — a broken update check for everyone. `release.yml` therefore runs
`gh release edit "$GITHUB_REF_NAME" --prerelease` on a nightly draft, so the
human who publishes it cannot make that mistake.

**A stable tag that disagrees with `package.json` is now refused.** Before this
step a hand-made `v0.2.0` on a `0.1.0` manifest would have shipped 0.1.0 under
the wrong name; only the nightly shape may differ from the manifest.

## External dependencies

| Dependency | Used for | Pitfalls |
|---|---|---|
| `electron-builder` | The whole build | It runs `@electron/rebuild` itself before packaging, and warns that the project's own `@electron/rebuild` devDependency is redundant — **it is not**: `npm install`'s `postinstall` needs it to make `npm run dev` and `npm run e2e` work, long before any packaging happens. It also warns about a missing `author` in `package.json`; harmless for an unsigned local build. An `npm install --ignore-scripts` skips the `postinstall` rebuild, and electron-builder's own rebuild then fixes the module for the *bundle* but not for the checkout — run `npx electron-rebuild -f -w better-sqlite3` if `npm run dev` stops loading the database afterwards |
| `dmgbuild` (vendored by electron-builder) | The disk image | Downloaded on the first `--mac` run, so the first build is several minutes slower than the rest and needs the network |
| `sips`, `iconutil` (macOS) | PNG scaling and the icns | `sips -z H W` takes **height first**. `iconutil` refuses an iconset that is missing any of the ten expected names, and the names are exact: `icon_16x16@2x.png`, not `icon_32x32.png` under a different name |
| `ffmpeg` | The demo MP4 and GIFs, through `scripts/render-demo.mjs` | `palettegen` / `paletteuse` must be two passes over the *same* filtered frames, or the palette describes footage that is not what gets encoded. The concat demuxer ignores the last entry's `duration` unless that file is listed once more after it. This build of ffmpeg has no `drawtext` filter, so frame-timestamp overlays are not available while inspecting a recording — use `tile` contact sheets and arithmetic instead |
| Playwright `recordVideo` | Nothing any more | Under Electron 44 a context launched with it never loads the renderer: the first window's URL stays empty and every locator times out. The recorder uses a CDP screencast instead |
| GitHub Actions (`actions/checkout@v4`, `actions/setup-node@v4`) | CI and release | Pinned to major tags. `setup-node`'s `cache: npm` needs `package-lock.json`, which is committed. `npm ci` runs the `postinstall` electron-rebuild, which downloads the Electron binary — the slow step of every job |
| `actionlint` 1.7.12 | Linting the workflows | Pinned by version and SHA-256 of the release tarball. On a runner with `shellcheck` installed — the Ubuntu images have it — it also lints every `run:` block, so findings can appear in CI that a local run without shellcheck does not report |
| `electron-updater` 6 (S7.4) | Reading the feed, downloading the zip, handing it to Squirrel.Mac | It is **CommonJS** while this project is ESM, so `import { autoUpdater } from 'electron-updater'` type-checks and then fails at runtime with "Named export 'autoUpdater' not found" — the default import plus a destructure is the documented interop and is what `src/main/ipc/updater.ts` does. It reads `app.getVersion()`, `app-update.yml` and the code signature of what it downloaded, so it is electron in everything but the package name and may only be imported from `src/main/ipc/` (CLAUDE.md rule #5). Its `error` event is an EventEmitter `error` event: with no listener it is re-thrown and takes the main process with it |
| Playwright `_electron.launch` | Both extra specs | `executablePath` plus an empty `args` is how a *packaged* app is launched; the `args: ['.']` every other spec uses points electron at a project directory and is wrong for a bundle. |
