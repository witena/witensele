# packaging — Implementation

## Approach

Eight pieces, none of which touches runtime behaviour except the third and the
seventh:

1. **`electron-builder.yml`** at the repository root. electron-builder reads it
   without being told to; `package.json` carries no `build` key, so there is one
   place to look.
2. **`build/`** holds the icon: the `icon.svg` the mark is drawn in, the
   1024 px `icon.png` it renders to, and the `icon.icns` macOS actually reads,
   plus `icon-dark.svg`, the same mark on an ink tile for the README and other
   dark surfaces (S7.1). `build/icon.iconset/` — the ten intermediate PNGs — is
   gitignored, because it is derived from the PNG and reproducible in one
   command.
3. **`bundledSkillsDir()`** in `src/main/index.ts`, the one function whose answer
   differs between a checkout and a bundle.
4. **`e2e/packaged.spec.ts`** plus `playwright.packaged.config.ts`, which assert
   against the shipped binary the three things a checkout cannot vouch for.
5. **`.github/workflows/`** (S7.2): `ci.yml` runs the delivery gate on every
   push and pull request; `release.yml` turns a `v*` tag into a draft GitHub
   Release carrying both dmgs. `auto-merge.yml` joined them later: it sets
   GitHub's auto-merge flag on a pull request the owner opens, so the merge
   happens when `ci.yml`'s two jobs pass instead of when somebody remembers.
6. **`scripts/sync-version.mjs`** (S7.2), the one line of glue that makes
   `npm version` enough to cut a release: it rewrites `APP_VERSION` from the
   manifest between npm's bump and npm's commit.
7. **The `zip` target and the `publish:` block** (S7.4), which together are the
   whole of what packaging owes the auto-updater: the zip is the only form
   macOS can install over a running app, and the publish block is copied into
   the bundle as `app-update.yml`, which is where `electron-updater` learns
   which feed to ask. Neither is read by anything at build time; both are read
   by a *running* app weeks later. See [`backend.md`](./backend.md),
   "Auto-update".
8. **`scripts/generate-licenses.mjs`** (S7.5), which runs from `prebuild` — so
   `npm run build`, and therefore `npm run dist`, starts by regenerating the
   licence list Settings → About renders. It reads `node_modules`, which a
   packaged app does not have, which is exactly why it runs at build time. See
   [`../ui-shell/implement.md`](../ui-shell/implement.md).
9. **`scripts/fetch-ant.mjs`**, which also runs from `prebuild` (optionally)
   and from the three `predist*` hooks (strictly). It fills `vendor/ant/<arch>/`
   from the release pinned in `build/ant-release.json`, and the second
   `extraResources` entry copies this architecture's folder to
   `Contents/Resources/bin`. Build time rather than run time, so the binary is
   inside the signature and there is no download to fail on a user's machine.

## Data flow

There is no user action here; the flow is the build.

```
npm run dist
  └─ predist                          scripts/fetch-ant.mjs → vendor/ant/{arm64,x64}/ant (sha256-checked)
  └─ npm run build
       ├─ prebuild                      scripts/generate-licenses.mjs → licenses.json
       └─ electron-vite build           → out/{main,preload,renderer}
  └─ electron-builder --mac             once per arch: arm64, then x64
       ├─ @electron/rebuild             better-sqlite3 checked for electron 44 / <arch>
       ├─ collect files                 out/** + package.json + production node_modules
       ├─ asar pack                     → Contents/Resources/app.asar
       │    └─ asarUnpack               better-sqlite3 → app.asar.unpacked/
       ├─ extraResources                resources/ → Contents/Resources/resources/
       ├─ icon                          build/icon.icns → Contents/Resources/icon.icns
       └─ dmg                           → dist/Witena-<version>-{arm64,x64}.dmg
                                          + .dmg.blockmap + latest-mac.yml
```

The two architectures cost far less than they look. `better-sqlite3` 13 ships
**N-API** prebuilds (`prebuilds/darwin-x64.node`, `prebuilds/darwin-arm64.node`,
and six more it does not need here), and N-API is ABI-stable across Node and
Electron — so `@electron/rebuild` finds nothing to compile and packaging the
foreign architecture on an Apple-silicon machine needs no cross-compiler. It
also means both bundles carry all eight prebuilds — 16 MB, of which the 14 MB
for Windows, Linux and the other macOS architecture is dead weight in each dmg.
That is a size wart, not a correctness problem, and it is in the backlog.

And the flow the bundle then runs, the first time it is opened:

```
Witena.app/Contents/MacOS/Witena
  → app.whenReady
  → bundledSkillsDir()  app.isPackaged ? process.resourcesPath/resources/skills
  → seedSkills(...)     copies into <userData>/skills/ when the library is empty
  → openDatabase(<userData>/witena.db)
       └─ better-sqlite3 dlopens app.asar.unpacked/.../better_sqlite3.node
       └─ runMigrations  SQL already inlined in the bundle by import.meta.glob
```

The migrations deserve the note: they are **not** files in the bundle. S1.2
inlined them with `import.meta.glob('./migrations/*.sql', { query: '?raw' })`, so
they are string literals inside `out/main/index.js` and packaging has nothing to
copy. `better-sqlite3` is the opposite case and is the reason `asarUnpack`
exists — `dlopen` takes a filesystem path, and a path inside an asar archive is
not one.

## Building the icon

No SVG rasteriser is installed on the build machine, so the Electron binary in
`node_modules` is used as one: a throwaway main script loads `build/icon.svg` in
a transparent window and writes `webContents.capturePage()` to a PNG. On a
Retina display that capture comes out at 2048 px, which is then downsampled to
1024 — supersampling the mark rather than rendering it at final size.

```sh
# 1. SVG → PNG (2048 on a Retina display), then down to 1024.
#    Chromium is the rasteriser; `sips` only ever resizes an existing bitmap.
electron scripts/render-icon.cjs build/icon.svg build/icon.png 1024
sips -z 1024 1024 build/icon.png --out build/icon.png

# 2. PNG → iconset → icns. Every variant is a downscale of the 1024, never a
#    fresh render at a tiny size.
mkdir -p build/icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out build/icon.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) build/icon.png --out build/icon.iconset/icon_${s}x${s}@2x.png
done

# 3. The 16px variant only: re-render with a thicker stroke, because 30px on a
#    1024 canvas is 0.47px at 16 and averages to grey mush. 56 was chosen by
#    eye against 44 / 68 / 80. See backend.md, "Building the icon".
sed 's/stroke-width="30"/stroke-width="56"/' build/icon.svg > /tmp/icon-16.svg
electron scripts/render-icon.cjs /tmp/icon-16.svg /tmp/icon-16.png 512
sips -z 16 16 /tmp/icon-16.png --out build/icon.iconset/icon_16x16.png

iconutil -c icns build/icon.iconset -o build/icon.icns
```

The render script is a throwaway, not a committed tool: it runs once per icon
change and the three artifacts it produces are in the repository, so a normal
build never needs it. `scripts/render-icon.cjs` is CommonJS despite the
package's `"type": "module"`, because it is fed straight to the Electron binary
rather than to node.

### Checking the result

`npm test` proves the SVG and the rail's inlined mark agree
(`brand-mark.test.ts`), and that is the whole automated gate. The rest is an eye,
and it is worth using:

```sh
# Unpack the icns back into the ten PNGs macOS will actually draw, then look at
# the small ones blown up with nearest-neighbour — a smooth downscale hides
# exactly the stair-stepping you are checking for.
iconutil -c iconset build/icon.icns -o /tmp/verify.iconset
```

What to look for at 16 and 32 px: the blades separate rather than merge, the
terracotta point is still a point rather than a pink pixel, the diagonals are
anti-aliased rather than stepped, and the tile edge is one pixel of partial alpha
with no coloured fringe and no border.

Then the real check — `npm run dist:dir` and

```sh
shasum -a 256 build/icon.icns dist/mac-arm64/Witena.app/Contents/Resources/icon.icns
/usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" dist/mac-arm64/Witena.app/Contents/Info.plist
```

The two hashes must match and the plist must say `icon.icns`; electron-builder
copies the file verbatim, so a mismatch means it read a different one.

## Making a release

Since S7.2 a release is a **tag**, and the tag is the only manual step:

```sh
# 1. The gate, on the machine. e2e is not run in CI, so it is run here.
npm run typecheck && npm test && npm run e2e

# 2. Bump, commit and tag in one command. `preversion` runs typecheck and the
#    unit tests again; the `version` lifecycle script rewrites APP_VERSION and
#    stages it, so the tagged commit carries both copies of the number.
npm version minor          # or patch / major → v0.2.0, committed and tagged

# 3. Push the branch and the tag together. The tag is what starts the workflow;
#    --follow-tags is what stops a tag from arriving without its commit.
git push --follow-tags

# 4. Watch `.github/workflows/release.yml`: typecheck, tests, both dmgs, upload.
#    It ends with a **draft** Release on GitHub.

# 5. Read the draft — two dmgs, two .blockmaps, latest-mac.yml — write the
#    notes, and press Publish. Nothing reaches a user before that click.
```

Before pressing Publish it is worth opening the artifact that was actually
uploaded rather than a local rebuild of it:

```sh
gh release download v0.2.0 --pattern '*arm64.dmg' --dir /tmp
hdiutil attach /tmp/Witena-0.2.0-arm64.dmg -mountpoint /tmp/witena-dmg -nobrowse
cp -R /tmp/witena-dmg/Witena.app /tmp/witena-app/
hdiutil detach /tmp/witena-dmg
WITENA_APP_PATH=/tmp/witena-app/Witena.app npm run e2e:packaged
```

The copy off the mounted image is not optional: a dmg is mounted read-only and a
macOS app writes inside its own bundle on first launch. `hdiutil info` afterwards
should list nothing of ours — a left-behind volume is the usual way a second run
picks up the previous build.

### Building by hand

`npm run dist` still does the whole local build — both architectures, both dmgs,
no upload. Adding `-- --publish always` is what the workflow does on top, and it
needs `GH_TOKEN`; there is rarely a reason to do that from a laptop.

`npm run dist:dir` skips the dmg and leaves `dist/mac-arm64/Witena.app`, which is
what to use while iterating on the config. Note that `--dir` replaces the
configured target and builds **only the host architecture**; to exercise the
other one, ask for it explicitly:

```sh
npm run build && npx electron-builder --mac --dir --x64   # → dist/mac/Witena.app
```

Either way the result is **unsigned** unless the machine has a Developer ID
certificate — see the next section.

### Building a signed release locally (S7.3)

Three things have to exist first, and none of them is in this repository:

**1. A Developer ID Application certificate in the login keychain.** Xcode →
Settings → Accounts → the Apple Developer account → Manage Certificates → **+** →
*Developer ID Application*. It has to be the Developer ID variant: an *Apple
Development* certificate signs for your own machines and Gatekeeper does not
accept it on anyone else's. Check what is there with

```sh
security find-identity -v -p codesigning
```

which should list one `Developer ID Application: <name> (<TEAMID>)`. **Zero
identities is the state this repository has been developed in** and is why
everything below is untried.

**2. An app-specific password**, created at appleid.apple.com → Sign-In and
Security → App-Specific Passwords. Not the Apple ID password; Apple rejects that.

**3. A notarization keychain profile**, stored once so nothing ever types the
password again:

```sh
xcrun notarytool store-credentials witena-notary \
  --apple-id <your-apple-id> --team-id <TEAMID>
```

It prompts for the app-specific password and writes the credentials into the
login keychain under the name `witena-notary`. **Run it yourself in your own
terminal.** The password must never reach a file in this repository, a shell
history shared with anyone, or a build log.

Then the build itself:

```sh
APPLE_KEYCHAIN_PROFILE=witena-notary npm run dist:signed
```

`dist:signed` is `npm run dist` plus
`-c.extraMetadata.witenaSignedBuild=true`, which is what tells the *running* app
it may let the Keychain wrap its secrets key file (backend.md, "What being
unsigned does to the stored secrets"). Notarization takes minutes and
electron-builder waits for it; the log ends with `notarization successful`.

Verify the artifact rather than the log:

```sh
hdiutil attach dist/Witena-<version>-arm64.dmg -mountpoint /tmp/witena-dmg -nobrowse

codesign --verify --deep --strict --verbose=2 /tmp/witena-dmg/Witena.app
spctl -a -vv /tmp/witena-dmg/Witena.app        # want: source=Notarized Developer ID
xcrun stapler validate /tmp/witena-dmg/Witena.app

hdiutil detach /tmp/witena-dmg
```

The three answer different questions and none replaces another: `codesign` that
the bundle and everything nested in it is intact and signed, `spctl` that
**Gatekeeper** accepts it, and `stapler` that the ticket was stapled into the
bundle — without which the first launch on a machine with no network is refused
even though the app is notarized.

Two failures worth recognising:

- `spctl` says `rejected` and `source=Unnotarized Developer ID` — signed, not
  notarized. The credentials were missing, so notarization skipped itself.
  Check the build log for `skipped macOS notarization`.
- The app is accepted but **does not open its database**, with a
  `Library not loaded` or `code signature` error naming `better_sqlite3.node`.
  That is library validation, and the fix is one key in
  `build/entitlements.mac.plist`; the file's own comment says which and why it
  was left out. This is the one thing about S7.3 that a certificate could prove
  wrong.

### The CI secrets

The release workflow signs when `CSC_LINK` exists and not otherwise, so adding
these five repository secrets is the whole of turning it on. Nothing in the
workflow changes.

| Secret | What it is |
|---|---|
| `CSC_LINK` | The Developer ID certificate **and its private key** as a base64 `.p12` — see below |
| `CSC_KEY_PASSWORD` | The password set when exporting that `.p12` |
| `APPLE_ID` | The Apple ID of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password. CI cannot use a keychain profile: `APPLE_KEYCHAIN_PROFILE` needs a keychain a runner does not have |
| `APPLE_TEAM_ID` | The ten-character team identifier, the same one in the certificate's name |

Exporting the `.p12`: in **Keychain Access**, find the *Developer ID
Application* certificate, expand it so the private key is selected **with** it,
right-click → Export 2 items → `.p12`, and set a password. A certificate exported
without its key signs nothing. Then

```sh
base64 -i Certificates.p12 | gh secret set CSC_LINK
```

which never puts the certificate on the clipboard or the screen. **Check the
path first**: if `base64` cannot read the file it prints an error, the pipe
carries nothing, and `gh` creates the secret **empty** — `gh secret list` shows
it all the same. That is what happened before the first `v*` tag (2026-09-19):
the run logged `CSC_LINK:` with nothing after it where the other four showed
`***`, and built unsigned. The `.p12` and the password are two
halves of a signing identity: keep the file out of the repository, off shared
drives, and delete it once the secret is set.

A partial set fails the build rather than skipping quietly — `APPLE_ID` without
`APPLE_APP_SPECIFIC_PASSWORD` stops with `APPLE_APP_SPECIFIC_PASSWORD env var
needs to be set`. That is deliberate: a release that silently skipped
notarization would be discovered by a user rather than by CI.

## What CI does not run

`ci.yml` runs `npm ci`, `npm run typecheck`, `npm test` and `npm run build` on
`macos-latest`, and lints every workflow file with `actionlint` on a Linux
runner. It does **not** run `npm run e2e`.

That is deliberate. The Playwright specs launch the real Electron binary, and
the ones that prove anything — a streamed reply, a round of two agents, the MCP
probe — need a local Ollama holding `qwen2.5:1.5b` and a warm npx cache. A
hosted runner has neither. The options were a suite that skips its own
assertions on every run, a runner that installs and warms a model for several
minutes per push, or an honest local gate; the third is the one that keeps
`npm run e2e` meaningful. It stays step 1 of "Making a release" above, and
`npm run e2e:packaged` stays step 5.

## Self-merging pull requests

The maintainer's own pull requests sat waiting for a human to come back and
press the button after CI had already answered. `auto-merge.yml` removes that
wait without removing the gate: on `opened`, `reopened` and `ready_for_review`
it runs one command,

```sh
gh pr merge --auto --merge "$PR_URL"
```

which sets GitHub's auto-merge flag. GitHub then merges the pull request when
`main`'s required status checks pass, and does nothing at all if they fail.
Everything that decides *whether* a merge is allowed is branch protection —
[`backend.md`](./backend.md), "Merging a pull request", lists the exact
settings, because they live in GitHub's configuration and nothing in the
repository can assert them.

Four things about the file are deliberate and worth not undoing:

- **`pull_request`, not `pull_request_target`.** The second is what most
  recipes on the internet use, and on a public repository it runs this
  workflow with a writable token for pull requests opened from **any fork**.
- **A job-level `if:` with three conditions** — same repository, not a draft,
  author is the owner's hard-coded login.
- **`permissions: contents: write` + `pull-requests: write`** and nothing else.
- **No `actions/checkout` and no third-party action.** `gh pr merge` takes a
  URL, so there is no code to fetch and no action version to pin; the job's
  supply chain is the `gh` the runner already carries.

`synchronize` is absent from the event list on purpose: auto-merge is a flag
that survives later pushes, so setting it once is enough, and `ready_for_review`
is what picks up a pull request that was opened as a draft.

**It does not close the loop on `main`.** A merge performed with `GITHUB_TOKEN`
triggers no further workflow run, so the `push` build of `main` never happens
for a merge this workflow queued — and with `strict: false`, the pull request's
own run tested the merge candidate only while the branch was up to date. Both
halves of that are recorded in the workflow file itself and in
[`backend.md`](./backend.md).

## The demo recording

`e2e/demo.record.ts` is in `e2e/` for its helpers but is not a test; both it and
`packaged.spec.ts` are named in `playwright.config.ts`'s `testIgnore`. It drives
the **built dev app** through a scripted tour with 600–1200 ms pauses and
`delay: 25` typing, and leaves its frames, a `recording.json` and four
screenshots in `test-results/demo/`.

It films itself over the DevTools protocol rather than with Playwright's
`recordVideo`. Under Electron 44 a context launched with `recordVideo` never
loads the renderer — `firstWindow()` resolves to a page whose URL stays empty —
so the tour opens a CDP session on the window and calls `Page.startScreencast`.
Chromium then delivers a JPEG each time the picture changes, stamped with the
compositor's clock. The recorder writes every frame to `frames/NNNNN.jpg` and
wraps each part of the tour in `mark(name, …)`, which records where that part
starts and ends on the same clock. `recording.json` is both lists.

`node scripts/render-demo.mjs` turns that into the README's media. It replays
the frames through ffmpeg's concat demuxer, each held for as long as it was on
screen, and writes `docs/assets/demo.mp4`, `docs/assets/demo.gif` and one
`docs/assets/features/<section>.gif` per `mark()`ed section — the six clips of
the README's feature wall (`providers`, `agents`, `discussion`, `parallel`,
`mcp`, `summary`).

Two things in that script are decisions rather than plumbing:

- **No frame is held longer than 1.2 s** (`MAX_HOLD`). The screencast only
  delivers a frame when something changes, so a long hold is a model thinking or
  a probe waiting. Capping it removes the dead air without touching anything
  that moves, which is most of why the GIF is half the size it used to be.
- **Every GIF is two-pass** (`palettegen`, then `paletteuse`) over the *same*
  filtered frames, so the palette describes what is actually encoded.
  `stats_mode=diff` weights the palette toward what changes between frames
  rather than the large flat background, and `dither=bayer:bayer_scale=5` keeps
  the dithering pattern stable from frame to frame, which is what makes the
  delta frames small.

### The size budget

| File | Size | Settings |
|---|---|---|
| `demo.gif` | 3.5 MB, 84 s | 1120 px, 12 fps, 48 colours |
| `demo.mp4` | 3.3 MB | 1440 x 900, H.264, CRF 24 |
| `features/*.gif` | 0.06–1.2 MB each, 2.6 MB together | 800 px, 10 fps, 48 colours |

The 48-colour cap dates from the first recording, where it was measured against
the alternatives: on a 63 s tour it cost less picture than dropping 200 px of
width did (7.7 MB against 7.6 MB, from 10.4 MB), and cutting the frame rate was
the worst trade of the three — it buys little size and it is the one thing that
makes streaming text look broken. The app's palette is a near-monochrome ground
plus one accent, so 48 entries describe it almost exactly.

## Key types and contracts

None. This feature adds no shared type, no `BackendClient` method, no IPC
channel and no event. The only runtime symbol it touches is the private
`bundledSkillsDir()`.

| Channel / method | Request | Response | Notes |
|---|---|---|---|
| — | — | — | Nothing added |

| Event | Payload | Emitted when |
|---|---|---|
| — | — | Nothing added |

## Tests

| File | Covers |
|---|---|
| `e2e/packaged.spec.ts` | The shipped bundle: the shell renders out of the asar; the shipped skill is listed under Settings → Skills (so `extraResources` and the packaged path resolution both work); one real Ollama reply completes (so `better-sqlite3` loaded from `app.asar.unpacked` and the migrations ran) |
| `src/main/packaging.test.ts` | The release manifest: `electron-builder.yml` names a dmg **and a zip** for both architectures (**S7.4** — the zip is what `electron-updater` applies), an `artifactName` carrying `${arch}` so the two cannot collide, `publish: github` / `releaseType: draft`, and that the publish block holds **nothing else** — a `token:` added there would ship inside every dmg. **S7.3** adds the signing shape — no `identity` key at all, `hardenedRuntime: true`, `gatekeeperAssess: false`, `notarize: true`, both entitlements options pointing at `build/entitlements.mac.plist` — plus that plist's exact grant list, and that `-c.extraMetadata.witenaSignedBuild=true` is passed by `dist:signed` and by neither `dist` nor `dist:dir`. Also that `release.yml`'s unsigned branch runs `unset CSC_LINK CSC_KEY_PASSWORD` before `npm run dist` (an empty secret is not an absent one to electron-builder), and that `APP_VERSION` equals `package.json`'s version, which is what notices if `npm version` ever runs without its lifecycle script |
| `src/main/secrets.test.ts` | **S7.3** adds `isSignedBuild` over a parsed manifest (boolean and string forms, and everything uncertain answering "not signed"), and `rewrapKeyFile`'s five outcomes with a fake wrapper: a plain file moved under the wrapper with the same 32 bytes and every stored ciphertext still readable; an already-wrapped file untouched; a refusing wrapper leaving the plain file and no temp file behind; no-ops on an unsigned build, a missing file and a missing key store; and a refusal to rewrite a file it does not recognise. Owned by [`../providers/implement.md`](../providers/implement.md) |
| `src/main/packaging.test.ts` (second half) | `auto-merge.yml`'s guards, because they are what stands between a public repository and a self-merging pull request from a stranger: the event is `pull_request` and `pull_request_target` appears nowhere, the `if:` still carries all three conditions (same repository, not a draft, the owner's login) joined by `&&`, `permissions:` is exactly the two write scopes, and the job checks nothing out and uses no action. `actionlint` proves the file is a valid workflow; only this proves it still says who may merge |
| `actionlint` (a CI job, not a file here) | Every workflow file: expression syntax, context availability — it is what catches `secrets.X` used in an `if:`, which looks right and never matches — action input names, and the shell in every `run:` block |

Run with `npm run e2e:packaged` and `WITENA_APP_PATH` pointing at a copy of
`Witena.app`. It is skipped — explicitly, in the report — when that variable is
not set, and its third case is skipped when Ollama does not hold
`qwen2.5:1.5b`.

What the unit test deliberately does not do is re-describe the build: asar
unpacking, the extra resources and the icon are claims about a filesystem, and
the only honest assertion about those is made against a real bundle, which is
`e2e/packaged.spec.ts`'s job. It covers exactly the fields a workflow reads.

`electron-builder.yml` is parsed there with **gray-matter**, by wrapping the
document in `---` delimiters. gray-matter is already a dependency (it is how
`SKILL.md` frontmatter is read) and it carries js-yaml; adding a second YAML
parser to `devDependencies` for one assertion would have been the wrong trade.

## Known limitations and TODOs

- **Signing runs locally but not in CI** (S7.3). The first signed and notarized
  build was produced and verified on 2026-09-17 — see [`backend.md`](./backend.md),
  "What the first signed build measured" — and S7.4 used the same certificate
  again for its two update bundles. What is still unproven is the *runner*: the five
  `CSC_*` / `APPLE_*` secrets were created on 2026-09-19, but `CSC_LINK` was
  created empty, so the first `v*` tag took the unsigned branch — and that branch
  then failed on the empty variable (fixed; see [`backend.md`](./backend.md),
  "The signing gate"). No runner has signed or notarized anything yet. Listed in
  STEPS.md, Phase 6.
- **A build you make yourself is unsigned**, and Gatekeeper refuses its first
  double-click; right-click → Open once. Verified to still be true after S7.3:
  `npm run dist:dir` with no identity logs `skipped macOS application code
  signing … 0 identities found` and produces a bundle `codesign -dv` reports as
  `flags=0x20002(adhoc,linker-signed)`, `TeamIdentifier=not set` — byte-for-byte
  the situation S4.4 documented. Documented in the README and in
  [`backend.md`](./backend.md).
- **A local `npm run dist` exits 1 after writing both dmgs.** The artifacts and
  blockmaps are complete and correct; the failure is a `TypeError: Cannot read
  properties of null (reading 'channel')` inside app-builder-lib's
  `computeChannelNames` while it builds `latest-mac.yml`, because a local run has
  no publish configuration to name a channel from. **Pre-existing, not S7.3**:
  the identical crash and exit code reproduce with the pre-S7.3
  `electron-builder.yml`. It dates from S7.2, which added the `publish:` block
  but only ever verified `dist:dir` locally. `npm run dist:dir` is unaffected,
  and the release workflow passes `--publish always` with a token, which probably
  is too — but the workflows have never run, so that is inference.
- **An auto-merged pull request leaves `main` with no run of its own**, because
  a merge performed with `GITHUB_TOKEN` triggers no workflow. `main` is proven
  by the pull request's run — which, under `strict: false`, tested the merge
  candidate only while the branch was up to date — and then by the next pull
  request. See "Self-merging pull requests" above.
- **Half of auto-merge is repository configuration, which no test can see.**
  Auto-merge enabled, branch deletion on merge, and a branch protection rule on
  `main` naming `check` and `actionlint`: all of it lives in GitHub's settings.
  Rename a job in `ci.yml` without renaming it in the protection rule and every
  pull request waits forever for a check that no longer reports. The values are
  written out in [`backend.md`](./backend.md), "Merging a pull request".
- **`release.yml` has never executed.** It is validated by `actionlint` 1.7.12
  and by reading; GitHub has never run it. (`ci.yml` has, on every push and
  pull request since the repository went public.) The first `v*`
  tag is the first execution, and the likely stumbles are known: whether
  `npm ci`'s `postinstall` rebuild finishes inside the runner's patience,
  whether electron-builder infers `owner`/`repo` from the checkout's git remote
  as expected, and whether a draft Release created by the first of two uploads
  is reused by the second. Listed in STEPS.md, Phase 6.
- **The x64 dmg has never been opened on an Intel Mac.** Packaging it is
  verified (`npx electron-builder --mac --dir --x64` produces an x86_64
  `Witena.app` carrying `prebuilds/darwin-x64.node`); running it needs hardware
  this project does not have.
- **Every bundle ships all eight `better-sqlite3` prebuilds**, 16 MB of which
  14 MB is for platforms the dmg does not target.
- **The dmg is ~150 MB.** Mostly the Electron runtime. The production dependency
  tree is shipped whole even though the renderer's share of it is already bundled
  into `out/renderer`, which is the obvious place to look if it ever matters.
- **The GitHub feed has never been read, because no Release has been
  published** (S7.4). The repository is public as of 2026-09-19, so GitHub will
  serve `latest-mac.yml`, the zips and the blockmaps to `electron-updater`'s
  unauthenticated request once they exist; until the first Release is published
  (a draft is not visible to that request) a check ends in `state: 'error'` with
  GitHub's 404 under it. The release workflow also has no signing secrets yet, so
  a tag pushed today would produce unsigned dmgs. The mechanism itself was proven
  against a local generic feed — procedure in [`backend.md`](./backend.md),
  "Auto-update".
- **A local `npm run dist` now writes four artifacts instead of two** (S7.4): a
  dmg and a zip per architecture, roughly 150 MB each. The zip is not a second
  download for a human — it is the only form the updater can apply — but it does
  double the time and the disk a local packaging run costs.
- **The release notes are written by hand** in the draft. Nothing generates
  them from the commits.
- **The demo recording needs a warm machine.** It expects `qwen2.5:3b` and
  `llama3.2:3b` pulled (it warms both up itself) and the npx cache primed for
  `@modelcontextprotocol/server-everything`. On a cold cache the MCP probe hits
  its 60 s cap and the tour films a minute of spinner.

## Recording pitfalls

Two things cost a re-record each, and both are worth knowing before editing the
tour:

1. **The MCP arguments box used to swallow a typed newline.** It was a
   controlled textarea rendered straight from the draft's normalised `args`, so
   the Enter between `-y` and `@modelcontextprotocol/server-everything` was
   erased by the next render and the two arguments arrived as one string;
   `npx -y@modelcontextprotocol/...` then hung until the probe's cap. The tour
   worked around it with `fill()`, which delivers both lines in one change
   event, and `e2e/mcp.spec.ts` always did the same — which is why the suite
   never caught it. The bug is fixed (the box now keeps its own raw text; see
   `docs/features/mcp/frontend.md`, "The line-list boxes") and `mcp.spec.ts`
   types the Enter for real. The tour still uses `fill()` because it reads as
   the paste a person would actually do.
2. **A cold npx cache looks exactly like a broken MCP server.** The first
   `npx -y @modelcontextprotocol/server-everything` downloads the package and its
   dependencies; warm, it connects in about 1.3 s and lists 13 tools. Prime it
   from a shell before recording.
