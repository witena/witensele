# packaging — Implementation

## Approach

Four pieces, none of which touches runtime behaviour except the last:

1. **`electron-builder.yml`** at the repository root. electron-builder reads it
   without being told to; `package.json` carries no `build` key, so there is one
   place to look.
2. **`build/`** holds the icon: the `icon.svg` the mark is drawn in, the
   1024 px `icon.png` it renders to, and the `icon.icns` macOS actually reads.
   `build/icon.iconset/` — the ten intermediate PNGs — is gitignored, because it
   is derived from the PNG and reproducible in one command.
3. **`bundledSkillsDir()`** in `src/main/index.ts`, the one function whose answer
   differs between a checkout and a bundle.
4. **`e2e/packaged.spec.ts`** plus `playwright.packaged.config.ts`, which assert
   against the shipped binary the three things a checkout cannot vouch for.

## Data flow

There is no user action here; the flow is the build.

```
npm run dist
  └─ npm run build                      electron-vite → out/{main,preload,renderer}
  └─ electron-builder --mac
       ├─ @electron/rebuild             better-sqlite3 rebuilt for electron 44 / arm64
       ├─ collect files                 out/** + package.json + production node_modules
       ├─ asar pack                     → Contents/Resources/app.asar
       │    └─ asarUnpack               better-sqlite3 → app.asar.unpacked/
       ├─ extraResources                resources/ → Contents/Resources/resources/
       ├─ icon                          build/icon.icns → Contents/Resources/icon.icns
       └─ dmg                           → dist/Witena-<version>-arm64.dmg
```

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
# 1. SVG → PNG (2048 on a Retina display), then down to 1024
electron scripts/render-icon.cjs build/icon.svg build/icon.png 1024
sips -z 1024 1024 build/icon.png --out build/icon.png

# 2. PNG → iconset → icns
mkdir -p build/icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out build/icon.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) build/icon.png --out build/icon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns build/icon.iconset -o build/icon.icns
```

The render script is a throwaway, not a committed tool: it runs once per icon
change and the three artifacts it produces are in the repository, so a normal
build never needs it.

## Making a release

```sh
npm run typecheck && npm test && npm run e2e     # the gate, unchanged
npm run dist                                     # → dist/Witena-<version>-arm64.dmg

hdiutil attach dist/Witena-0.1.0-arm64.dmg -mountpoint /tmp/witena-dmg -nobrowse
cp -R /tmp/witena-dmg/Witena.app /tmp/witena-app/
hdiutil detach /tmp/witena-dmg
WITENA_APP_PATH=/tmp/witena-app/Witena.app npm run e2e:packaged
```

The copy off the mounted image is not optional: a dmg is mounted read-only and a
macOS app writes inside its own bundle on first launch. `hdiutil info` afterwards
should list nothing of ours — a left-behind volume is the usual way a second run
picks up the previous build.

`npm run dist:dir` skips the dmg and leaves `dist/mac-arm64/Witena.app`, which is
what to use while iterating on the config.

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

Run with `npm run e2e:packaged` and `WITENA_APP_PATH` pointing at a copy of
`Witena.app`. It is skipped — explicitly, in the report — when that variable is
not set, and its third case is skipped when Ollama does not hold
`qwen2.5:1.5b`.

There is no unit test: the subject is a YAML file and a filesystem layout, and
the only honest assertion about either is made against a real build.

## Known limitations and TODOs

- **Unsigned.** Gatekeeper refuses a double-click on the first launch; the user
  has to right-click → Open once. Documented in the README and in
  [`backend.md`](./backend.md).
- **arm64 only.** An Intel or universal build is a one-line change to
  `mac.target[0].arch` that nobody has run.
- **The dmg is ~150 MB.** Mostly the Electron runtime. The production dependency
  tree is shipped whole even though the renderer's share of it is already bundled
  into `out/renderer`, which is the obvious place to look if it ever matters.
- **The version in the artifact name comes from `package.json`** and nothing
  bumps it. There is no release process yet.
- **`latest-mac.yml` and the blockmap** are produced by the dmg target for an
  updater that does not exist. Harmless, and left alone rather than suppressed
  with a flag that would have to be revisited when an updater arrives.
- **The demo recording needs a warm machine.** It expects `qwen2.5:3b` and
  `llama3.2:3b` pulled (it warms both up itself) and the npx cache primed for
  `@modelcontextprotocol/server-everything`. On a cold cache the MCP probe hits
  its 60 s cap and the tour films a minute of spinner.

## Recording pitfalls

Two things cost a re-record each, and both are worth knowing before editing the
tour:

1. **The MCP arguments box swallows a typed newline.** It is a controlled
   textarea whose `textToArgs` drops empty lines, so the Enter between `-y` and
   `@modelcontextprotocol/server-everything` is erased by the next render and the
   two arguments arrive as one string. `npx -y@modelcontextprotocol/...` then
   hangs until the probe's cap. The tour uses `fill()` with both lines in one
   change event; `e2e/mcp.spec.ts` always did, which is why the suite never
   caught it. The underlying paper-cut is a UI bug, not a test problem.
2. **A cold npx cache looks exactly like a broken MCP server.** The first
   `npx -y @modelcontextprotocol/server-everything` downloads the package and its
   dependencies; warm, it connects in about 1.3 s and lists 13 tools. Prime it
   from a shell before recording.
