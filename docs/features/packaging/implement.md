# packaging — Implementation

## Approach

Six pieces, none of which touches runtime behaviour except the third:

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
   Release carrying both dmgs.
6. **`scripts/sync-version.mjs`** (S7.2), the one line of glue that makes
   `npm version` enough to cut a release: it rewrites `APP_VERSION` from the
   manifest between npm's bump and npm's commit.
7. **`scripts/generate-licenses.mjs`** (S7.5), which runs from `prebuild` — so
   `npm run build`, and therefore `npm run dist`, starts by regenerating the
   licence list Settings → About renders. It reads `node_modules`, which a
   packaged app does not have, which is exactly why it runs at build time. See
   [`../ui-shell/implement.md`](../ui-shell/implement.md).

## Data flow

There is no user action here; the flow is the build.

```
npm run dist
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

## What CI does not run

`ci.yml` runs `npm ci`, `npm run typecheck`, `npm test` and `npm run build` on
`macos-latest`, and lints both workflow files with `actionlint` on a Linux
runner. It does **not** run `npm run e2e`.

That is deliberate. The Playwright specs launch the real Electron binary, and
the ones that prove anything — a streamed reply, a round of two agents, the MCP
probe — need a local Ollama holding `qwen2.5:1.5b` and a warm npx cache. A
hosted runner has neither. The options were a suite that skips its own
assertions on every run, a runner that installs and warms a model for several
minutes per push, or an honest local gate; the third is the one that keeps
`npm run e2e` meaningful. It stays step 1 of "Making a release" above, and
`npm run e2e:packaged` stays step 5.

## The demo recording

`e2e/demo.record.ts` is in `e2e/` for its helpers but is not a test; both it and
`packaged.spec.ts` are named in `playwright.config.ts`'s `testIgnore`. It drives
the **built dev app** through a scripted tour with 600–1200 ms pauses and
`delay: 25` typing, filming it with `recordVideo` on the Electron context, and
leaves a `.webm` plus four screenshots in `test-results/demo/`.

The GIF is made from the `.webm` with ffmpeg, two-pass so the palette is built
from the frames that actually appear:

```sh
PRE="trim=start=0.8,setpts=PTS-STARTPTS,fps=12,scale=1120:-1:flags=lanczos"
ffmpeg -i test-results/demo/demo.webm \
  -vf "${PRE},palettegen=max_colors=48:stats_mode=diff" -y palette.png
ffmpeg -i test-results/demo/demo.webm -i palette.png \
  -lavfi "${PRE}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -y docs/assets/demo.gif
```

`stats_mode=diff` weights the palette toward what changes between frames rather
than the large flat dark background, and `dither=bayer:bayer_scale=5` keeps the
dithering pattern stable from frame to frame, which is what makes the delta
frames small. The `trim` drops the eight-tenths of a second before the tour's
first click.

### Hitting the 8 MB budget

The first attempt — the full 63 s at 12 fps and 1200 px with a default 256-colour
palette — came out at **10.4 MB**. Three levers, measured rather than guessed:

| Change | Result |
|---|---|
| 12 fps, 1200 px, 256 colours | 10.4 MB |
| 10 fps, 1120 px, 256 colours | 9.8 MB |
| 12 fps, 1000 px, 256 colours | 7.6 MB |
| 12 fps, 1200 px, **48 colours** | 7.7 MB |
| **12 fps, 1120 px, 48 colours** | **6.8 MiB / 7.2 MB** ← shipped |

The interesting result is the fourth row: capping the palette at 48 colours cost
less picture than dropping 200 px of width did. The app's palette is a dark
near-monochrome plus one accent, so 48 entries describe it almost exactly — the
extracted frames show no banding and every line of the transcript is still
readable. Cutting frame rate was the worst trade of the three: it buys little
size and it is the one thing that makes streaming text look broken.

The MCP section was **not** cut in the end, but it nearly had to be — see
"Recording pitfalls" below.

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
| `src/main/packaging.test.ts` | The release manifest: `electron-builder.yml` names a dmg for both architectures, an `artifactName` carrying `${arch}` so the two cannot collide, `publish: github` / `releaseType: draft`, and the still-unsigned `identity: null` that the README's Gatekeeper note depends on. Also that `APP_VERSION` equals `package.json`'s version, which is what notices if `npm version` ever runs without its lifecycle script |
| `actionlint` (a CI job, not a file here) | Both workflow files: expression syntax, context availability — it is what catches `secrets.X` used in an `if:`, which looks right and never matches — action input names, and the shell in every `run:` block |

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

- **Unsigned.** Gatekeeper refuses a double-click on the first launch; the user
  has to right-click → Open once. Documented in the README and in
  [`backend.md`](./backend.md).
- **The workflows have never executed.** They are validated by `actionlint`
  1.7.12 and by reading; GitHub has never run either of them. The first `v*`
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
- **`latest-mac.yml` and the blockmaps** are uploaded to the Release for an
  updater that does not exist yet (S7.4). Harmless, and the feed is exactly
  what `electron-updater` will read, so producing it now costs nothing.
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
