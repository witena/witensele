# packaging — Frontend

**This feature has no renderer code.** S4.4 added no page, no component, no
store field, no `BackendClient` call and no translation key, and S7.2 — the CI
and release workflows — added none either. A packaged build renders exactly what
`npm run dev` renders; nothing in the UI branches on `app.isPackaged`, and
nothing in it branches on how the bundle was built.

The version number is the one thing a release changes that the renderer could
one day show. It does not today: `APP_VERSION` (`src/shared/version.ts`, kept in
step with `package.json` by `scripts/sync-version.mjs`) is read only by
`src/main/mcp/manager.ts`, for the MCP client handshake. Settings → About, where
a user would read it, arrives with S7.4/S7.5 — and when it does, the string it
renders must still go through `t()` with the number interpolated, not a
hardcoded "Witena 0.2.0" (CLAUDE.md rule 4).

The three renderer-visible facts it does produce, and where they belong:

| Fact | Where it lives |
|---|---|
| The application icon in the Dock, the Finder and the About panel | `build/icon.icns`, referenced by `mac.icon` in `electron-builder.yml`. It is **not** the window icon — macOS takes that from the bundle, and `createWindow` sets none. See [`backend.md`](./backend.md), "Building the icon" |
| The window's size, colour and title bar | Unchanged from S1.5; the contract is written out in [`../ui-shell/backend.md`](../ui-shell/backend.md), "Window options" |
| The skills a fresh installation opens with | Seeded before the first window exists, and then read through the ordinary `skills.list` handler. The screen is [`../skills/frontend.md`](../skills/frontend.md)'s Settings → Skills |

## Screenshots and the demo recording

The one renderer-adjacent artifact this feature owns is the imagery in
`docs/assets/`, produced by `e2e/demo.record.ts` driving the real UI:

| File | What it shows |
|---|---|
| `docs/assets/demo.gif` | The scripted tour: providers, two agents, a round-robin discussion, parallel speaking, MCP, the Actions card. 1120 x 700, 12 fps, 63 s, 7.2 MB — how that budget was met is in [`implement.md`](./implement.md), "Hitting the 8 MB budget" |
| `docs/assets/demo-poster.png` | A still from the parallel round, used as the README's poster frame |
| `docs/assets/chat.png` | The chat screen mid-discussion, with a tool card and both presence dots |
| `docs/assets/agents.png` | The agent configuration page with skills, MCP and memory filled in |
| `docs/assets/settings.png` | Settings → Providers with the Ollama preset and a successful connection test |

The four PNGs are captured at the window's native retina size and downsampled to
**1440 x 900** with `sips`, which is the artboard size and roughly a quarter of
the file size of the raw capture. The poster is a screenshot taken at the moment
the parallel round finishes rather than a frame lifted out of the GIF: the same
instant, but crisp instead of palette-reduced.

All five are recorded with the UI in **English**: the README is English, and so
is everything committed to this repository (CLAUDE.md rule #1). The recording
switches the language through the real settings toggle as its first action
rather than pre-seeding the setting, because that toggle is part of what the
tour is showing.

The window is pinned to 1440 × 900 — the mockup's artboard size, the same one
every spec's screenshots use — so the imagery in `docs/` stays comparable with
the shots in `test-results/shots/`.
