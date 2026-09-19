# packaging — Context

## Problem

Everything before S4.4 runs from a checkout: `npm run dev`, or the built `out/`
directory the end-to-end harness launches. That is a developer's app, not a
product. Packaging turns the repository into a single `Witena.app` inside a
disk image that someone who has never seen the source can drag into
`/Applications` and open, with the skills the project ships already in it and a
database that opens on the first launch.

## Scope

- `electron-builder.yml`: macOS dmgs for **arm64 and x64**, signed and notarized
  when the machine or the runner has a Developer ID and unsigned when it does
  not (S7.3), plus `build/entitlements.mac.plist` — the hardened runtime's two
  exceptions.
- The application icon: `build/icon.svg` → `build/icon.png` → `build/icon.icns`.
  Since S7.1 that SVG is the real brand mark rather than a placeholder, and it is
  the same drawing the navigation rail inlines.
- `extraResources`, so `resources/skills/` ships with the build, and the path
  resolution in `src/main/index.ts` that finds it once packaged.
- `asarUnpack` for `better-sqlite3`, whose `.node` binary cannot be `dlopen`ed
  out of an asar archive.
- `npm run dist` and `npm run dist:dir`.
- `e2e/packaged.spec.ts`, run on its own by `npm run e2e:packaged`, which drives
  the shipped binary rather than `out/`.
- The demo recording (`e2e/demo.record.ts`), the script that renders it
  (`scripts/render-demo.mjs`) and the repository `README.md` that shows it,
  because all three are produced from the same shipped surface. The README has
  one translation, `docs/readme/README.zh-CN.md`, which shares its media.
- **Since S7.4**, auto-update: the `zip` target beside the dmg (the only form
  `electron-updater` can apply on macOS), the `publish:` block read back out of
  the packaged `app-update.yml`, and the `WITENA_UPDATE_FEED` escape hatch that
  points a build at a generic feed instead. The code that consumes it —
  `src/main/updates/` and `src/main/ipc/updater.ts` — belongs to
  [`backend-client`](../backend-client/context.md); this feature owns what the
  build has to produce for it.
- **Since S7.2**, the two GitHub Actions workflows: `ci.yml` (the gate on every
  push and pull request) and `release.yml` (a `v*` tag → two dmgs in a draft
  Release), plus the version bump that produces such a tag —
  `scripts/sync-version.mjs` behind npm's `version` lifecycle. S7.5 added a
  second build-time script, `scripts/generate-licenses.mjs`, behind `prebuild`:
  the licence list Settings → About renders is derived from `node_modules`,
  which a packaged app does not carry, so it has to be turned into data before
  the bundle is made.
- The Anthropic CLI (`ant`) shipped inside the bundle: `scripts/fetch-ant.mjs`,
  the pin in `build/ant-release.json` and the second `extraResources` entry.
  Why the app ships it at all is a providers decision and is recorded in
  [`../providers/context.md`](../providers/context.md); what this feature owns
  is that the right architecture's binary, checksummed, ends up signed inside
  each dmg. `gcloud` is not shipped — it is hundreds of megabytes and a Python
  runtime, not one static binary.

## Out of scope

| Not done | Owner |
|---|---|
| **Producing** a signed and notarized build | S7.3 configured it; nothing has exercised it. There is no certificate on this machine and no GitHub secrets, so the signed path is reasoning checked against electron-builder's source. See "Open questions" and STEPS.md S7.3 |
| Wrapping the secrets key file on a real signed build | Same reason. `rewrapKeyFile` is unit-tested against a fake `safeStorage`; the real Keychain on a real Developer ID bundle has never been asked |
| Windows and Linux targets | PLAN.md scopes the MVP to macOS. The layout has never been reviewed on another platform (`titleBarStyle: 'hiddenInset'` is macOS-only), so shipping a build there would be a promise nobody has checked |
| **Updates from the real GitHub feed** | S7.4 built and proved the whole mechanism against a **local generic feed**. It cannot work against this repository yet, because the repository is **private** and `electron-updater`'s GitHub provider cannot read a private repository's release assets without a token — which would have to ship inside the app. The fix is to make the repository public, not to embed a token; recorded in STEPS.md's Phase 6 |
| A universal binary | Two dmgs instead: each is half the download, and the native module is compiled per architecture either way (PLAN.md, "Local release") |
| Windows and Linux in CI | Same reason as the targets themselves. `ci.yml` runs on `macos-latest` only |
| e2e in CI | `npm run e2e` drives the real Electron binary and the specs that matter talk to a local Ollama. A hosted runner has neither, and a suite that skips its own assertions is worse than one that is honestly local |
| Publishing the Release | Deliberate: the workflow uploads a **draft**. A human reads the artifacts and presses Publish |

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
| **S7.3: `identity` is absent rather than `null` or a name** | Keep `identity: null` and a second config file for signed builds; name the certificate | The absence is what makes one file produce both builds: electron-builder signs with a Developer ID if the keychain has one and logs `skipped macOS application code signing` if it does not. `null` means "never sign" and would need a second configuration to override — two files that drift. A name ties the repository to one developer's keychain. The property S4.4 wanted from the explicit `null` — that the artifact never silently picks up a stray identity — is kept in CI by `CSC_IDENTITY_AUTO_DISCOVERY`, which the release workflow sets false unless the certificate secret exists |
| **S7.3: the minimum entitlements, without `disable-library-validation`** | electron-builder's default template, which includes it; @electron/osx-sign's default, which adds camera, microphone, Bluetooth, USB, printing and location | Every entitlement is an exception to what the hardened runtime promises. `better_sqlite3.node` is signed by this build with this project's own identity — osx-sign signs every Mach-O under `Contents/` — so same-team library validation passes and the exception buys nothing while widening what the app may load. The risk taken is real and named: it cannot be confirmed without a certificate, and if the first signed build fails to load the module the fix is one key, documented in the plist itself |
| **S7.3: the signed-build flag travels in the packaged `package.json`** | The `WITENA_SIGNED_BUILD` environment variable S7.6 used; a constant baked into the bundle by the Vite build; an Info.plist key | The variable was already recorded as broken: it is read by the *running* process, and a variable exported while building is not in the environment of an app launched days later. `extraMetadata` writes the answer into the bundle, where the app can read it with `app.getAppPath()`. A Vite-time constant would have to be threaded through electron-vite's config and would make the *build* command decide, not the *packaging* command — and it is packaging that knows whether a certificate was found. An Info.plist key would need electron to read it, which `secrets.ts` may not do |
| **S7.3: re-wrapping the key file silently, but only the container** | Leave it (S7.6's position); offer it in Settings with a confirmation | S7.6 declined because "rewriting the user's stored secrets" needs consent. The distinction that changes the answer is that this rewrites the **container, not the contents**: the same 32 bytes go back in, every stored ciphertext stays readable, and no provider key is re-encrypted. Nothing the user can observe changes except that the key is now protected — which is what signing was bought for. A screen and a confirmation for "would you like your key file to be safer" is a prompt with one sensible answer. The write is atomic and fails soft, which is what makes it safe to do unasked |
| `extraResources: resources → resources` (the nested `Resources/resources`) | `from: resources/skills, to: skills`, which is the shorter path | Keeping the folder's own name means the packaged tree mirrors the repository, so `bundledSkillsDir()` is one join below a root that differs and anything added to `resources/` later ships without another config edit. The cost is a path that reads oddly once |
| `files: [out/**, package.json]` and no `node_modules` entry | Spelling out `node_modules/**` | electron-builder appends the production dependency tree on its own. Listing it by hand is a second copy of the same fact, and the two would drift |
| `e2e/packaged.spec.ts` outside `npm run e2e` | A tag or a `test.skip` inside the normal suite | The spec cannot run without a dmg, and producing one takes minutes. A skip inside the suite would either be a silent pass on every ordinary run, or a twelve-minute prelude to the everyday command. Its own config says which it is |
| The icon is drawn as an SVG and rasterised with the Electron binary | Committing only a PNG; installing a rasteriser | No SVG rasteriser is installed on the build machine, and the project already has a browser engine in `node_modules`. Committing the SVG keeps the mark editable and reviewable in a diff; the PNG and the icns are committed beside it so nobody has to re-render to build |
| The 16 px variant is re-rendered from the same SVG with a thicker stroke (S7.1) | Accept the mush; commit a separate `icon-16.svg`; thicken the stroke everywhere | 0.47 px of stroke averages to grey at 16 px, which is the one size where an icon has to be recognised rather than read. A second committed file would be a second drawing that can drift; a `sed` over the one SVG cannot. Thickening everywhere would coarsen the sizes that are already right |
| The tile has no border (S7.1) | A hairline edge, as the proposal drew on a light ground | A hairline is invisible against a light Dock and a grey fuzz at 16 px — it makes the mark *look* like a rendering artefact at exactly the size where it has least room. The tile's own anti-aliased edge is enough |
| `build/icon-dark.svg` is kept but never shipped (S7.1) | Derive a dark version when something needs one; ship both and pick at runtime | macOS takes one icns; there is nothing to pick between. It is kept because the README and future dark surfaces need a mark that does not carry a white slab, and re-deriving it by hand each time is how the two drawings drift apart. `brand-mark.test.ts` holds it to the same geometry as the light one |
| The README's Chinese version is committed, as `docs/readme/README.zh-CN.md` | A gitignored `README.zh.md` like every other Chinese document; no translation | The README is the one document written for people who have not cloned the repository, and a language link on GitHub cannot point at a file that was never pushed. Every other Chinese document is a working copy for whoever is editing, which is why those stay ignored. CLAUDE.md rule #1 names this file as its one exception |
| The README's clips are cut from one filmed tour by `mark()`ed sections | One recording per feature; screenshots instead of clips | One tour means one warm-up, one set of agents and one chat, so the six clips are visibly the same session and re-recording is one command. Separate recordings would each repeat the provider and agent setup off camera |
| ~~One dmg, no zip~~ — **S7.4 added the zip** | Keep the dmg only and teach the updater to read it; a universal zip | S4.4's reasoning was "the zip exists for auto-update, which the MVP does not have", and S7.4 is that auto-update. There is no alternative to reason about: macOS's `Squirrel.Mac` replaces an app bundle from a **zip** and nothing else, and `latest-mac.yml` is generated from whatever targets were built — a release with only a dmg is a feed `electron-updater` downloads and then cannot apply. The dmg stays what a human downloads; the zip is what the app downloads |
| **S7.4: `provider: github` stays although the repository is private** | Switch to `provider: generic` and host `latest-mac.yml` somewhere public; ship a read-only token in the bundle | The owner intends to make the repository public, and on that day `github` starts working with no edit. A token is out of the question whatever its scope: `app-update.yml` is a plain file inside the dmg, so "a token in the config" means "a token handed to everyone who downloads the app" — `packaging.test.ts` asserts the `publish` block has none. A second host is a second thing to keep in step with the Release for as long as the private phase lasts. Until then a check ends in `state: 'error'` with GitHub's own 404 under it, which is at least honest |
| **S7.4: `WITENA_UPDATE_FEED` lifts the signed/packaged gate as well as changing the URL** | A second variable for the gate; never lift it | The variable exists to exercise the updater on a build that would otherwise refuse to look, so a version of it that changed only the URL would be useless for the one job it has. It is a developer's environment variable: nothing in the UI writes it, nothing reads it back, and an app the user double-clicks has never seen it |
| electron-builder publishes the Release itself (`--publish always`) | `softprops/action-gh-release` uploading `dist/*` | electron-builder is what writes `latest-mac.yml` and the `.blockmap` files, and it writes them knowing which release and which files they describe. A generic upload step would carry the same bytes but leave the update feed a hand-maintained copy of a fact the builder already knows — and S7.4's `electron-updater` reads exactly that feed. The cost is a `GH_TOKEN` env var and less obvious logs |
| A **draft** Release, never a published one | Publishing straight from the tag | A tag is cheap to push and a published release is not cheap to retract. The draft is the review step: the artifacts exist, the notes can be written, and nothing is offered to a user until someone clicks |
| Both architectures in one `electron-builder` invocation | A `strategy.matrix` of two jobs | `latest-mac.yml` describes a *release*, not an architecture. Two jobs would each write one listing only their own dmg and the second upload would overwrite the first, leaving an updater feed that knows about half the release |
| `actionlint` as a pinned, checksummed release binary | An npm devDependency; `rhysd/actionlint@v1` | Nothing in the product needs a workflow linter in `node_modules`, and pinning a third-party action by tag trusts a pointer somebody else can move. A version plus a SHA-256 is the strongest pin available without vendoring the binary |
| `npm version` bumps, and a `version` lifecycle script rewrites `APP_VERSION` | Reading `package.json` from `src/shared/`; bumping the constant by hand | `src/shared/` is imported by all three processes, so pulling the manifest in to read one field would put it in every bundle. A hand-edited constant is the classic thing to forget in a release, so the bump is scripted and `src/main/packaging.test.ts` fails if the two ever disagree |

## Open questions

- **The signed path has never produced an artifact** (S7.3). The configuration,
  the entitlements, the notarization credentials and the key-file re-wrap are all
  in place and all unexercised: this machine reports `0 valid identities found`
  and the repository has no signing secrets. Four things stay open until a
  certificate exists — a signed, notarized dmg that `spctl` reports as
  `Notarized Developer ID`; `better_sqlite3.node` loading under the hardened
  runtime without `disable-library-validation`; the key file re-wrapped on a real
  signed launch; and the secrets actually added to GitHub. Listed in STEPS.md
  S7.3.
- **The workflows have never run.** They are written against a repository whose
  Actions have never been enabled, and validated only by `actionlint`. The
  first tag will be the first execution; what it is most likely to trip over is
  listed in `implement.md`, "Known limitations", and in STEPS.md's Phase 6.
- **The GitHub feed has never been read** (S7.4). The download-and-install path
  was proven end to end on 2026-09-17 against a **local** generic feed with two
  locally built, signed bundles — see [`backend.md`](./backend.md),
  "Auto-update". What has never happened is the same walk against a real draft
  Release, because the repository is private and the provider cannot read it.
  The first public release is the first test of that half.
- Whether the dmg's 150 MB is worth attacking. Most of it is the Electron
  runtime; the biggest avoidable share is `node_modules` dependencies that only
  the renderer bundle uses and that are therefore shipped twice.
