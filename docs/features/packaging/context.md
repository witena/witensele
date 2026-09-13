# packaging — Context

## Problem

Everything before S4.4 runs from a checkout: `npm run dev`, or the built `out/`
directory the end-to-end harness launches. That is a developer's app, not a
product. Packaging turns the repository into a single `Witena.app` inside a
disk image that someone who has never seen the source can drag into
`/Applications` and open, with the skills the project ships already in it and a
database that opens on the first launch.

## Scope

- `electron-builder.yml`: a macOS **arm64 dmg**, unsigned.
- The application icon: `build/icon.svg` → `build/icon.png` → `build/icon.icns`.
- `extraResources`, so `resources/skills/` ships with the build, and the path
  resolution in `src/main/index.ts` that finds it once packaged.
- `asarUnpack` for `better-sqlite3`, whose `.node` binary cannot be `dlopen`ed
  out of an asar archive.
- `npm run dist` and `npm run dist:dir`.
- `e2e/packaged.spec.ts`, run on its own by `npm run e2e:packaged`, which drives
  the shipped binary rather than `out/`.
- The demo recording (`e2e/demo.record.ts`) and the repository `README.md` that
  shows it, because both are produced from the same shipped surface.

## Out of scope

| Not done | Owner |
|---|---|
| Code signing and notarization | Needs an Apple Developer account the project does not have. `identity: null`, and the README tells the user about Gatekeeper's right-click → Open |
| Windows and Linux targets | PLAN.md scopes the MVP to macOS. The layout has never been reviewed on another platform (`titleBarStyle: 'hiddenInset'` is macOS-only), so shipping a build there would be a promise nobody has checked |
| Auto-update | `electron-updater` needs a signed build and a release feed. `latest-mac.yml` falls out of the dmg target anyway and is harmless; nothing reads it |
| Universal / x64 builds | `arch: [arm64]` only. An Intel build is one line, but it has not been run |
| A CI release workflow | PLAN.md leaves GitHub Actions for later |

## Dependencies

| Feature | What packaging needs from it |
|---|---|
| [`skills`](../skills/context.md) | `resources/skills/` and `seedSkills`; the packaged path is the thing `extraResources` exists for |
| [`database`](../database/context.md) | `better-sqlite3` is the only native module, and the migrations are inlined into the bundle by `import.meta.glob(… '?raw')` — so nothing has to be copied beside the asar for them |
| [`ui-shell`](../ui-shell/context.md) | `createWindow`'s options are what the packaged window still uses; the icon is the one thing S4.4 adds to that surface |

Nothing depends on packaging in return: no runtime code branches on it except
`bundledSkillsDir()`.

## Decisions and trade-offs

| Decision | Alternatives considered | Why this one |
|---|---|---|
| Unsigned, `hardenedRuntime: false`, `identity: null` | Ad-hoc signing; a paid Developer ID | There is no certificate behind this repository. Ad-hoc signing does not satisfy Gatekeeper either, so it would add a step and change nothing a user sees. An explicit `null` also stops electron-builder from silently picking up whatever identity happens to be in the developer's keychain, which would make the artifact depend on the machine that built it |
| `extraResources: resources → resources` (the nested `Resources/resources`) | `from: resources/skills, to: skills`, which is the shorter path | Keeping the folder's own name means the packaged tree mirrors the repository, so `bundledSkillsDir()` is one join below a root that differs and anything added to `resources/` later ships without another config edit. The cost is a path that reads oddly once |
| `files: [out/**, package.json]` and no `node_modules` entry | Spelling out `node_modules/**` | electron-builder appends the production dependency tree on its own. Listing it by hand is a second copy of the same fact, and the two would drift |
| `e2e/packaged.spec.ts` outside `npm run e2e` | A tag or a `test.skip` inside the normal suite | The spec cannot run without a dmg, and producing one takes minutes. A skip inside the suite would either be a silent pass on every ordinary run, or a twelve-minute prelude to the everyday command. Its own config says which it is |
| The icon is drawn as an SVG and rasterised with the Electron binary | Committing only a PNG; installing a rasteriser | No SVG rasteriser is installed on the build machine, and the project already has a browser engine in `node_modules`. Committing the SVG keeps the mark editable and reviewable in a diff; the PNG and the icns are committed beside it so nobody has to re-render to build |
| One dmg, no zip | Both, as electron-builder does by default | The zip exists for auto-update, which the MVP does not have. A second 150 MB artifact with no reader is noise |

## Open questions

- Signing and notarization, if the project ever ships to people who are not
  willing to right-click → Open. That is a purchase, not a code change.
- Whether the dmg's 150 MB is worth attacking. Most of it is the Electron
  runtime; the biggest avoidable share is `node_modules` dependencies that only
  the renderer bundle uses and that are therefore shipped twice.
