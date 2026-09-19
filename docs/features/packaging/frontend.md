# packaging — Frontend

**This feature has almost no renderer code.** S4.4 added no page, no component,
no store field, no `BackendClient` call and no translation key; S7.2 — the CI
and release workflows — added none either, and neither did S7.3.

**S7.4 is the first exception, and a narrow one.** A packaged build still
renders exactly what `npm run dev` renders, but it is now the first time the UI
branches on *how the bundle was built*: an unsigned or unpackaged build reports
`state: 'unsupported'` from `system.updateStatus` and Settings → About prints the
reason instead of a live check. That is deliberate rather than a leak of build
detail into the page — "why is there no update" is a question the screen has to
answer, and a button that silently did nothing would be worse than the sentence.
The screen itself, the notice bar and the store belong to
[`../ui-shell/frontend.md`](../ui-shell/frontend.md); what this feature owns is
the fact the two of them render.

Shipping the Anthropic CLI added no renderer code either. Its only visible
effects are one more row in Settings → About's licence list (`ant`, MIT, written
by `scripts/generate-licenses.mjs` from the same pin the download uses) and a
state the sign-in panel stops reaching on a packaged build — see
[`../providers/frontend.md`](../providers/frontend.md).

S7.3 is worth one sentence here because it introduced the first runtime fact
that *could* have reached the UI and deliberately does not. Whether the build was
signed decides whether the Keychain wraps the secrets key file, and the key file
being wrapped or plain changes **nothing the user sees**: the same providers, the
same keys, the same "a key is stored" hint. The one case that does show — a key
this build cannot decrypt — already has its line under the provider card, and it
belongs to [`../providers/frontend.md`](../providers/frontend.md). A user should
not have to reason about their key file's storage format, so there is no screen
for it and no notice when it is re-wrapped; the re-wrap logs to the console and
is otherwise invisible, which is the point.

The version number is the one thing a release changes that the renderer shows.
**Settings → About arrived in S7.5** and reads `APP_VERSION` and
`APP_REPOSITORY_URL` from `src/shared/version.ts`, the former kept in step with
`package.json` by `scripts/sync-version.mjs`; `src/main/mcp/manager.ts` reads the
same constant for the MCP client handshake. The screen belongs to
[`../ui-shell/frontend.md`](../ui-shell/frontend.md). Its labels go through
`t()`; the version string, the repository URL and the licence rows are printed
as **data**, because an identifier is the same in both languages — which is the
same call the `ant` install command and a working-directory path already make.

The other renderer-visible thing a build now produces is that licence list:
`prebuild` regenerates `src/renderer/src/generated/licenses.json` from the
production dependency tree, so a packaged app ships the list of what it was
actually built from.

The three renderer-visible facts it does produce, and where they belong:

| Fact | Where it lives |
|---|---|
| The application icon in the Dock, the Finder and the About panel | `build/icon.icns`, referenced by `mac.icon` in `electron-builder.yml`. It is **not** the window icon — macOS takes that from the bundle, and `createWindow` sets none. See [`backend.md`](./backend.md), "Building the icon" |
| The same mark inside the running app | `components/ui/brand-mark.tsx` on the navigation rail (S7.1). Nothing loads `build/icon.svg` at runtime: the rail inlines the geometry so its blades can be `currentColor` and follow the theme. The two are held together by `brand-mark.test.ts`, not by a shared asset — see [`../ui-shell/frontend.md`](../ui-shell/frontend.md) |
| The mark in the README | `build/icon.png`, at `width="64"` inline with the centred title, in both `README.md` and `docs/readme/README.zh-CN.md`. The committed 1024 px artifact rather than a copy under `docs/assets/`, so the README cannot show a mark the build no longer ships. Checked against GitHub's light (`#ffffff`), dark (`#0d1117`) and dark-dimmed (`#22272e`) page grounds: on dark the white tile reads as the app icon, on light it disappears into the page and the mark reads tile-less. Both hold with no hairline |
| The window's size, colour and title bar | Unchanged from S1.5; the contract is written out in [`../ui-shell/backend.md`](../ui-shell/backend.md), "Window options" |
| The skills a fresh installation opens with | Seeded before the first window exists, and then read through the ordinary `skills.list` handler. The screen is [`../skills/frontend.md`](../skills/frontend.md)'s Settings → Skills |
| The version, the repository link and the licences of the bundled dependencies | Settings → About (S7.5), from `@shared/version` and the generated `licenses.json` |
| Whether this build can update itself, and which version is waiting | Settings → About's Updates block and the notice bar at the bottom of the window (S7.4). Both read `stores/updates.ts`, which mirrors `system.updateStatus`; see [`../ui-shell/frontend.md`](../ui-shell/frontend.md) |

## Screenshots and the demo recording

The one renderer-adjacent artifact this feature owns is the imagery in
`docs/assets/`, produced by `e2e/demo.record.ts` driving the real UI:

| File | What it shows |
|---|---|
| `docs/assets/demo.gif` | The scripted tour: providers, two agents, a round-robin discussion, parallel speaking, MCP, the Actions card. 1120 x 700, 12 fps, 84 s, 3.5 MB. The README's hero, linked to the MP4 |
| `docs/assets/demo.mp4` | The same tour at 1440 x 900 in H.264, for anyone who clicks the hero |
| `docs/assets/features/<section>.gif` | One clip per `mark()`ed section of the tour — `providers`, `agents`, `discussion`, `parallel`, `mcp`, `summary` — 800 px wide at 10 fps. The right-hand column of the README's feature table |
| `docs/assets/demo-poster.png` | A still from the parallel round. Not referenced by the README since it moved to the feature-table layout; kept for anything that needs one crisp frame |
| `docs/assets/chat.png` | The chat screen mid-discussion, with a tool card and both presence dots |
| `docs/assets/agents.png` | The agent configuration page with skills, MCP and memory filled in |
| `docs/assets/settings.png` | Settings → Providers with the Ollama preset and a successful connection test |

The four PNGs are captured at the window's native retina size and downsampled to
**1440 x 900** with `sips`, which is the artboard size and roughly a quarter of
the file size of the raw capture. The poster is a screenshot taken at the moment
the parallel round finishes rather than a frame lifted out of the GIF: the same
instant, but crisp instead of palette-reduced.

The README is laid out as a centred header, a hero, and a two-column feature
table — a paragraph on the left, that feature's clip on the right — followed by
the provider list, install and development notes. `docs/readme/README.zh-CN.md`
is the same page in Simplified Chinese, linked from under the badges; it reuses
every asset through relative paths, so there is one set of media for both.

The appearance setting defaults to `system`, so the recording takes the palette
of the machine it is filmed on. The current media is the light palette.

All of them are recorded with the UI in **English**: the README is English, and so
is everything committed to this repository (CLAUDE.md rule #1). The recording
switches the language through the real settings toggle as its first action
rather than pre-seeding the setting, because that toggle is part of what the
tour is showing.

The window is pinned to 1440 × 900 — the mockup's artboard size, the same one
every spec's screenshots use — so the imagery in `docs/` stays comparable with
the shots in `test-results/shots/`.
