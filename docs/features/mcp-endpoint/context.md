# mcp-endpoint — Context

## Problem

A user who spends the day in Claude Code, Codex or another agentic coding tool
wants to ask a Witena group without leaving it: "have the architecture committee
look at this migration". Witena runs in the background, the coding agent calls it
through MCP, the group discusses, and the conclusion comes back as a tool result.
The discussion is an ordinary chat — live in the Witena window, stored,
continuable there.

## Scope

STEPS.md Phase 10, against the design in PLAN.md "Witena as an MCP server (the MCP
endpoint)". That PLAN section — its shape diagram, decision table and tool table —
is the specification; this folder does not repeat it.

- A local MCP endpoint hosted by the desktop app (`src/main/mcp-endpoint/`).
- A stdio shim shipped inside the bundle (`src/mcp-shim/`, `bin/witena-mcp`).
- Six discussion tools, later `list_committees`, resources and one prompt.
- Background launch, single-instance lock, the `witena://chat/<id>` link.
- Settings → Integrations: the switch, and one-click install into Claude Code and
  Codex. Provenance of endpoint-sent messages (`OriginPart`).

The executable breakdown — one work package per subagent, with frozen contracts
and verification commands — is [`tasks.md`](./tasks.md).

## Out of scope

| Not here | Owner |
|---|---|
| Committees themselves: data, page, new-chat dialog | STEPS.md Phase 9 and its feature folder. This feature only *calls* them (WP-14) |
| Witena as an MCP *client* | `../mcp/` |
| The endpoint on the online server (`/mcp` behind accounts) | After S8.2; backlog |
| A menu-bar item, idle-quit, MCP elicitation as a remote permission prompt | Backlog (S10.7 records them) |
| Handing off to Witena's executor from the IDE | Never: the calling agent is the executor |

## Dependencies

| Needs | From |
|---|---|
| `HandlerMap`, `AppContext`, `EventBus` | `../backend-client/`, `../server/` — the endpoint is a third transport beside IPC and HTTP |
| `run.finished`, `run.round`, `permission.requested`, `ConclusionPart` | `../orchestration/` (S5.14, S5.16) |
| Read-only workspace tools when a chat has a `workdir` | `../executor/` (S5.11) |
| Bundle layout, `extraResources`, hardened runtime | `../packaging/` |
| Committee handlers and the expansion inside `chats.create` | Phase 9, for WP-14 only |

## Decisions and trade-offs

The decision table lives in PLAN.md and is not duplicated. Decisions made *below*
PLAN's level are recorded here as work packages land.

| Decision | Alternatives considered | Why this one |
|---|---|---|
| Low-level SDK `Server` on both sides, tool inputs as zod schemas in `src/shared/mcp-tools.ts`, JSON Schema derived with `z.toJSONSchema` | `McpServer.registerTool` in the app and hand-written JSON Schema in the shim | One definition serves the shim's offline `tools/list` and the app's validation; two would drift |
| Work is cut into packages that freeze their contracts first (WP-1) | One branch per STEPS step | Packages can run in parallel in separate worktrees and each is verifiable by command |

## What the spike found

> Filled by WP-0a and WP-0b. Until then every number in this feature that came
> from memory rather than measurement is listed in `tasks.md` under "Assumptions".

### WP-0a platform (2026-09-20)

Machine: macOS 27.0 (26A428), Apple Silicon, Electron 44.3.0 / Node 24.20.0.
Two bundles were used. **dist** is `dist/mac-arm64/Witena.app` from
`npm run dist:dir` — Developer ID signed, hardened runtime
(`CodeDirectory … flags=0x10000(runtime)`), not notarized. **installed** is
`/Applications/Witena.app` 0.1.0, which `spctl -a -vvv -t exec` reports as
`accepted, source=Notarized Developer ID` and `xcrun stapler validate` accepts —
so the notarized bundle was measured without downloading anything. Every launch
was given a throwaway `WITENA_USER_DATA` under the scratchpad, and every process
started here was quit again.

**1. Run-as-node from the shipped bundle — confirmed.**

```
printf 'one\ntwo\nthree\n' (one line per second, through a pipe) |
  ELECTRON_RUN_AS_NODE=1 <bundle>/Contents/MacOS/Witena echo.cjs
```

Both bundles run the script. `process.versions.node` is `24.20.0`,
`process.versions.electron` is `44.3.0`, `process.execPath` is the bundle's own
`Contents/MacOS/Witena`. stdin and stdout are **unbuffered when piped**: with the
writer sending one line per second, each echoed line came back 1–3 ms after it
was written, not in one burst at exit. The hardened runtime does not block it —
the notarized, stapled bundle behaves exactly like the locally signed one.

*No Dock icon.* While a run-as-node process was alive,
`lsappinfo list | grep -c 'bundleID="com.witena.app"'` stayed at 1 (the user's
own running app) and `lsappinfo info -only pid,name <pid>` returned nothing: the
process never registers with LaunchServices, so it has no Dock tile and no menu
bar. Startup cost of the wrapper is small — `/usr/bin/time -p` on a one-line
script gives 0.07–0.08 s real from either bundle, against 0.06 s for `node`
itself.

*Fuses.* There is no fuse configuration anywhere: no `@electron/fuses` in
`package.json`, no `flipFuses` call in `scripts/`, and `electron-builder.yml` has
no `afterPack` / `afterSign` hook that could flip one. `RunAsNode` is therefore
at Electron's default, which the runs above prove is *enabled*. **It must stay
that way** — `bin/witena-mcp` (WP-9) has no other way to execute the shim.

**2. Hidden launch — confirmed, with two findings.**

```
open -g -j -a dist/mac-arm64/Witena.app \
  --env WP0A_LOG=<log> --env WITENA_USER_DATA=<temp> --args --background
```

`--background` **is** in `process.argv` of a packaged build, and nothing else is:
`argv === ['<bundle>/Contents/MacOS/Witena', '--background']`, so the packaged
argv has no extra entries to skip (`app.isPackaged` was `true`). Read from a
temporary `appendFileSync` in `src/main/index.ts`, reverted afterwards.

*Focus is kept.* The frontmost application (`lsappinfo front`) was the same
before and after each launch. The window the app still creates — `--background`
is not implemented until WP-8 — did not come forward.

Cold start, three runs, from the `open` call to the line logged immediately after
`createWindow()` (the whole of `whenReady`: database opened, handlers registered,
window created, which is where WP-7's host would already be listening):

| Run | process start | electron `ready` | window created |
|---|---|---|---|
| 1 (first launch of a freshly built bundle) | +2649 ms | +2710 ms | **+2853 ms** |
| 2 | +506 ms | +566 ms | **+709 ms** |
| 3 | +502 ms | +550 ms | **+692 ms** |

Almost all of it is `open` plus process start; from `ready` to a usable app is
~145 ms. **WP-5's 20 s launch timeout is comfortably right** — a factor of seven
over the worst number here. The first run is the only cold one; a bundle macOS
has already validated starts in ~0.7 s.

*Finding for WP-5:* `open -a <bundle>` on a bundle that is **already running**
does not start a second instance and prints *"Application … was already running
and so the additional environment variables could not be set."* For the shim this
is the desired behaviour (an app that is up already has a discovery file), but it
means `open` can never be used to *re-configure* a running Witena, and any test
that needs two instances of the same bundle must pass `-n`.

*Finding for WP-9 and for anyone measuring:* a launch of a **second Developer ID
signed copy** of the app with a *fresh* `WITENA_USER_DATA` raises a macOS
SecurityAgent (Keychain) prompt from `safeStorage`, and `whenReady` blocks on it
until it is answered — no database, no window, no endpoint. It does not affect a
user's normal launch (same bundle, existing key file), but it is why the numbers
above were taken with `createSafeStorageStore()` temporarily stubbed out. The
step it skips is a Keychain read of a few milliseconds.

**3. `userData` and the single-instance lock — confirmed.**

`app.getPath('userData')` read before any override, in the packaged build, is
`/Users/<user>/Library/Application Support/Witena`. **`<APP_DIR>` is `Witena`**
(`app.setName(APP_NAME)` runs before it), which is what `userDataDirFor` in
`src/shared/mcp-discovery.ts` must produce for the no-override case. Corroborated
independently by the running app's helper processes, whose command line carries
`--user-data-dir=/Users/<user>/Library/Application Support/Witena`.

`requestSingleInstanceLock()` called immediately after
`app.setPath('userData', …)` **is keyed by `userData`**:

| Instance | `WITENA_USER_DATA` | `requestSingleInstanceLock()` |
|---|---|---|
| A | `…/udA` | `true` |
| B, launched while A runs | `…/udB` | `true` |
| A2, launched while A runs | `…/udA` | `false` |

A and B ran side by side, each with its own window. The mechanism is visible in
the directory: Chromium writes `SingletonLock -> <host>-<pid>` (plus
`SingletonCookie`, `SingletonSocket`) **inside** `userData`, so parallel
Playwright launches with different temp directories cannot evict each other.
Note for WP-8: the instance that loses the lock never reaches `ready` at all — it
sat parked until it was killed — so `app.quit()` on `false` is what ends it
cleanly, and nothing may be assumed to run afterwards.

## Open questions

- The real names of Phase 9's handlers and types (WP-14 reads them, never guesses).
- Whether Codex surfaces MCP resources or prompts at all (WP-0b); S10.6 drops
  whatever no client shows.
