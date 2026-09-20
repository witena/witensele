# mcp-endpoint — Frontend

> The feature's own screen is built. WP-12 added Settings → Integrations; WP-8's
> deep-link handler and WP-13's provenance chip are the two surfaces it has
> outside that section.

Surface, by work package (`tasks.md`):

| Surface | Package |
|---|---|
| Settings → Integrations: the endpoint switch, status, Claude Code and Codex cards, the generic snippet | WP-12 `[x]` (2026-09-20) |
| `stores/integrations.ts` and the pure `components/settings/integration-display.ts` behind it | WP-12 `[x]` (2026-09-20) |
| `settings.integrations.*` in both locale files, and `settings.sections.integrations` | WP-12 `[x]` (2026-09-20) |
| `IntegrationStatus` and the three `integrations.*` calls the section is built from — backend only, no component yet | WP-11 `[x]` (2026-09-20) |
| `errors.integrations_no_launcher`, `errors.integrations_client_not_installed` in both locale files | WP-11 `[x]` (2026-09-20) |
| The "via {{client}}" chip on a message sent through the endpoint | WP-13 `[x]` (2026-09-20) |
| Selecting a chat on the `ui.open-chat` event (`witena://chat/<id>`) | WP-8 `[x]` (2026-09-20) |
| `AppSettings.mcpEndpoint.enabled` on the settings store — the value the switch writes, with no control of its own yet | WP-7 `[x]` (2026-09-20) |
| "Create a Claude Code agent for each committee" | WP-14 |

## HTTP endpoint and guards (WP-4)

Still nothing in the renderer, and the table above is unchanged. One thing WP-12
will want when it writes the status line: the endpoint's refusals are **English
JSON-RPC error objects written for the calling model**, exactly like the tool
descriptions — a 401 says to re-read the discovery file, a 403 says the endpoint
is not reachable from a web page. They are read by the shim and by an IDE, never
by the Witena window, so they are outside i18n by the same rule that puts the
tool descriptions outside it (CLAUDE.md rule 4 is about what the *user* sees).
If Settings → Integrations ever surfaces "the last call was refused", it says so
with its own `settings.integrations.*` key rather than showing the sentence.

Every string goes through `t()` under `settings.integrations.*` and
`chat.viaClient`; no component reaches past `BackendClient`.

## Host and the setting (WP-7)

Still no component, and deliberately: WP-7 adds the *setting* the switch will
write, not the switch. `AppSettings.mcpEndpoint.enabled` reaches the renderer
through `settings.get` / `settings.update` exactly as `theme` and `editor` do,
so `useSettingsStore` already carries it and WP-12's section needs one more
action beside `setEditor` and `setExecutor` rather than a new method.

Two things WP-12 should know before it writes that switch:

- **The toggle is live and it is the write that does it.** `settings.update`
  starts or stops the listening host after storing the row, so the section needs
  no second call and no "restart Witena" copy. The discovery file appearing and
  disappearing in the user-data directory is the observable effect, which is what
  its e2e case asserts.
- **A host that fails to start does not fail the update.** The switch will show
  `enabled: true` while nothing is listening, which is the honest state and the
  reason the status line reads `listening` from `integrations.status` (WP-11)
  rather than inferring it from the setting. The two are different facts and the
  section should show them as two.

Nothing in this package produces user-facing text, so no locale key changes
hands: the one string the main process writes is a `console.warn` for a host
that would not start, which is a developer's line and not the user's (CLAUDE.md
rule 4).

## Discussion watcher (WP-2)

No renderer surface, and deliberately none: `src/main/mcp-endpoint/discussion.ts`
watches the same `EventBus` the window already watches, and adds no event, no
store field and no component. A discussion started through the endpoint shows up
in the window as an ordinary chat — the message list, the member panel and the
presence dots are the ones `chats` and `presence` already own, and the only thing
that will ever mark it as *not* typed by the user is WP-13's "via {{client}}"
chip.

The progress lines the watcher produces ("Round 2 — Ada, Lin", "Ada has spoken")
are **not** UI copy and never reach the renderer: they are written in English for
the calling model's progress notifications, for the same reason the tool
descriptions are (below).

## Tools (WP-3)

Still nothing in the renderer, and the table above is unchanged. Two things the
window will meet indirectly:

- **A discussion started through the endpoint is an ordinary chat.**
  `start_discussion` creates it with `chats.create` and writes to it with
  `chat.send`, so the left column, the message list and the member panel show it
  the moment it exists, with no new event and no store field. The only thing that
  will ever mark it as not typed by the user is WP-13's "via {{client}}" chip.
- **A chat the endpoint created is titled from the question's first line**, cut
  at 60 characters, which is what the user sees in the sidebar until they rename
  it. That title is *content*, like every other chat title, and so is outside
  i18n — the same rule that keeps `DEFAULT_CHAT_TITLE` a plain string.

The hints and the markdown `get_discussion` renders are, like the tool
descriptions and the watcher's progress lines, written in English for the calling
model and never drawn in the window.

One boundary worth stating, because `src/shared/mcp-tools.ts` is importable from
the renderer and its strings are English: the tool `title` and `description`
fields are **not** UI copy and must never be rendered. Their reader is the
calling model, they are deliberately outside i18n (CLAUDE.md rule 4 is about
what the user sees), and a component that showed one would be showing the user
an untranslated prompt. If Settings → Integrations ever wants to list the tools,
it names them with its own `settings.integrations.*` keys.

## Opening a chat from a link (WP-8)

Two edits, no component: `lib/event-bridge.ts` gains one `case`, and
`stores/chats.ts` gains the method it calls.

```
open-url / second-instance argv           src/main/index.ts
  → ui.open-chat { chatId }               the bus, then BackendClient.subscribe
    → useChatsStore.applyOpenRequest(id)  did this window select it?
      → yes: useUiStore.setPage('chats')
```

`applyOpenRequest` returns a boolean, and the bridge navigates only when it is
`true`. A link to a chat this window does not have must not take the user off
the page they were on and show them nothing.

**An id the loaded list does not contain is ignored, with no error.** The link
came from outside the app — a tool result pasted into a terminal, a note, a
message — so "no such chat" is not a failure the user has to be told about, and
it must not clear a chat that *is* open either. The main process deliberately
does not check first; see [backend.md](./backend.md).

**The one exception is a list that has not loaded yet**, and it is the cold
launch, which is the case this whole feature exists for: the app was not
running, the shim started it, the main process created the window and emitted as
soon as it had loaded — while `chats.load()` is still in flight. The id is then
held in `pendingOpenId` and answered by the first `load` that finishes, which
either selects it or drops it. Nothing else clears it: an id still absent after
a full read is not going to appear later.

Navigation is not re-sent in that path, because a window created for a link is a
fresh one and the shell already opens on Chats (`stores/ui.ts`).

`stores/ui.ts` is unchanged. Its header calls the shell "deliberately not a
router" and says a deep link would become "the thing that writes these two
fields" — this is that, one `setPage` call from the event bridge, with the
routing decision staying in the bridge rather than in a router.

### Tests

`src/renderer/src/stores/chats.test.ts`, `describe('ui.open-chat')`, driven
through `applyBackendEvent` so the wiring is tested with the store: a known id
selects and navigates; an unknown one selects nothing, navigates nowhere, leaves
`error` unset and does not clear the current selection; an id that arrives
before `load` is honoured when the list lands, and dropped when the list turns
out not to contain it.

## Provenance: the "via" chip (WP-13)

The one surface this feature has inside a chat. A user message that arrived
through the endpoint carries an `OriginPart`, and its row gains a chip on the
header line, beside the round and the timestamp:

| Piece | Where |
|---|---|
| `originClient(parts) → string \| null` | `components/chat/transcript-rows.ts`, beside `isConclusion` |
| `viaClient` on the message row | the same file's `TranscriptRow`, filled by `buildTranscriptRows` |
| The prop | `MessageItem`'s `viaClient?: string \| null`, passed down by `MessageList` |
| The chip | `message-item.tsx`: `<Badge data-testid="message-via">{t('chat.viaClient', { client })}</Badge>` |
| The copy | `chat.viaClient`, `via {{client}}` in `en.json` and translated beside it in `zh-CN.json` |

Three things about it are deliberate:

- **The reading lives in the row model, not in the component.** The same argument
  `conclusion` makes: a `string | null` computed by a pure function is a unit
  test, and the identical `find` inside a component is not — the renderer suite
  runs in `node`, with no DOM.
- **It is a chip on the header line, not a line in the body.** It is a fact
  *about* the message rather than part of what was said, and the header line is
  already where the reader is asking who, when and in which round.
- **The client named itself.** `viaClient` is text a remote party chose. The
  backend has already trimmed it, stripped its control characters and capped it
  at `MAX_ORIGIN_CLIENT_CHARS`; the renderer draws it as text and branches on
  nothing.

Nothing else about the row changes, which is the point: a message an IDE sent is
an ordinary user message — same avatar, same body, same mentions — and the chip
is the only thing that says otherwise.

### Tests

`components/chat/transcript-rows.test.ts`: the row carrying the client name and
an ordinary row carrying `null`; the flag read wherever it sits in `parts`; an
empty client name treated as no flag; the first of two flags winning; and
`originClient` / `isConclusion` not reading each other's part.

## Shim (WP-5)

Still nothing in the renderer, and the table above is unchanged: `src/mcp-shim/`
is a separate process that never sees the window, has no store field and adds no
event.

Two things WP-12 will want when it writes Settings → Integrations:

- **The shim's three refusals are English text for the calling model**, exported
  as `SHIM_ERROR_TEXT` from `src/mcp-shim/connect.ts`. They are read by an IDE
  and never by the Witena window, so they are outside i18n by the same rule that
  puts the tool descriptions and the endpoint's JSON-RPC errors outside it. One
  of them tells the user's agent to say "open Witena → Settings → Integrations
  and turn the MCP endpoint on" — when that section exists it says the same
  thing in the user's own language, with its own `settings.integrations.*` key,
  rather than showing this sentence.
- **`out/mcp-shim/witena-mcp.cjs` is what the snippet block points at.** The
  copyable fallback WP-12 shows is built from WP-9's `launcherPath`, and in a
  build that ships none (development) the honest command is
  `node <repo>/out/mcp-shim/witena-mcp.cjs` — which `npm run build` and
  `npm run mcp-shim:build` both produce.

## Packaging the launcher (WP-9)

Still nothing in the renderer: no page, no store field, no event, no key, and the
table above is unchanged. What WP-9 produces that will reach a screen is **one
string**, and WP-12 is what prints it:

| Fact | Value | Where it comes from |
|---|---|---|
| The command a client registers, in a packaged build | `<bundle>/Contents/Resources/bin/witena-mcp` | `mcpLauncherPath()` in `src/main/index.ts`, handed to the context by WP-11 and reported by `integrations.status` as `launcherPath` |
| The same in a checkout | `null` | There is no bundle, so there is no stable command. WP-12 shows `node <repo>/out/mcp-shim/witena-mcp.cjs` and says why |

Two consequences for the section WP-12 writes:

- **The path is data, not copy.** It goes into the snippet block verbatim, like
  the version string in Settings → About and the `ant` install command; the
  sentence *around* it goes through `t()`. A path is the same in both languages,
  and a translated one would be wrong in both.
- **`null` is a state the section has to render, not an error.** A developer
  running `npm run dev` sees the fallback snippet and a note; nothing is
  disabled, because the endpoint itself works there — it is only the *command*
  that has no stable spelling.

## The Integrations backend (WP-11)

Still nothing in the renderer, and the table above is unchanged — but this is the
package WP-12 draws from, so here is everything the section will hold.

**One read, three calls.** `BackendClient.invoke('integrations.status')` answers
everything the section shows, and the two actions answer with the *same shape*,
so the store never has to re-read after a click:

```ts
interface IntegrationStatus {
  endpoint: { enabled: boolean; listening: boolean; port?: number }
  launcherPath: string | null
  clients: IdeClientStatus[]   // one per IDE_CLIENT_IDS, always in that order
}
interface IdeClientStatus {
  id: 'claude-code' | 'codex'
  installed: boolean
  connected: boolean
  command?: string
  stale: boolean
}
```

`clients` is always as long as `IDE_CLIENT_IDS` and always in its order, so the
section can render a card per entry without matching by id — and adding a third
client will add a card with no change in the renderer's shape.

**The card's five states**, and which call each offers:

| `installed` | `connected` | `stale` | The card says | The button |
|---|---|---|---|---|
| `false` | — | — | not installed | none (the snippet block is the fallback) |
| `true` | `false` | — | installed, not connected | Connect → `integrations.connect` |
| `true` | `true` | `false` | connected | Disconnect → `integrations.disconnect` |
| `true` | `true` | `true` | connected to another installation (`command` says which) | Repair → `integrations.connect`, the same call |

**The endpoint line is two facts, not one.** `enabled` is the switch's position —
it is also `settings.mcpEndpoint.enabled`, so a section that already mirrors the
settings store may read it there — and `listening` (with `port`) is whether this
process has a socket. They agree in the desktop app and disagree wherever
`ctx.mcpEndpoint` is `null`; a line that showed only one would be wrong in the
case a user is most likely to report.

**Connect throws the switch.** `integrations.connect` enables the endpoint before
it registers anything, so a section that keeps a settings store has to expect
`settings.mcpEndpoint.enabled` to become `true` without the switch having been
touched — either by re-reading settings after a successful connect, or by
driving the switch from `IntegrationStatus.endpoint.enabled`, which is the
simpler of the two.

**The two refusals already have copy.** Both are `validation` with a
`ValidationReason` in `details`, so `translateFailure` from
`src/renderer/src/i18n/errors.ts` writes the sentence with no new mapping:

| Reason | English key | When the section sees it |
|---|---|---|
| `integrations_no_launcher` | `errors.integrations_no_launcher` | Connect in a development build. Reachable, so the button is offered and the error line explains — see below |
| `integrations_client_not_installed` | `errors.integrations_client_not_installed` | A client uninstalled between the status read and the click |

A CLI that ran and refused arrives as `internal` with the CLI's own words in
`error.message` — the dimmed detail line, never the sentence (`errors.ts`).

**With `launcherPath: null`, Connect is offered and fails.** That is deliberate
rather than an oversight to design around: the button may be disabled with the
snippet block shown instead, but if it is pressed the refusal is a translated
sentence and not a crash. Nothing else about a development build is degraded —
the endpoint listens, the shim works, and only the *command* has no stable
spelling.

## Settings → Integrations (WP-12)

The section every package above was writing towards. Everything it draws comes
from one call, `integrations.status`, and everything it does is the two calls
beside it.

| Piece | Where |
|---|---|
| The section | `src/renderer/src/pages/settings/integrations-section.tsx` |
| The store | `src/renderer/src/stores/integrations.ts` |
| The pure display rules and the snippets | `src/renderer/src/components/settings/integration-display.ts` |
| The nav entry | `integrations` in `SETTINGS_SECTIONS` (`stores/ui.ts`), directly under `mcp` |
| The copy | `settings.integrations.*` and `settings.sections.integrations`, both locale files |
| The switch's write | `useSettingsStore.setMcpEndpoint({ enabled })` |

It sits directly under **MCP servers** in the nav because the two are one
subject from opposite ends: that section is the tools Witena *calls*, this one is
Witena being the tool something else calls.

### Three blocks

**The endpoint** — a `Toggle`, a `StatusPill` and one sentence. The pill is
*two* facts collapsed into three states by `endpointState`: `off` when the row is
off, `listening` (with the port) when this process has a socket, and
`not-listening` — the warn tone — when the row says on and nothing is listening.
That third state is not hypothetical: WP-7 lets a host that fails to start leave
the row `true`, and it is exactly the state a user would report. A pill that read
only `enabled` would agree with the switch and tell them nothing.

**The clients** — one card per entry of `IntegrationStatus.clients`, rendered in
the order it arrives, which WP-11 guarantees is `IDE_CLIENT_IDS`. No card is
matched by id and no id is written into the JSX, so a third client is a card with
no change here. `ideClientState` collapses the three booleans into the four
states, and `ideClientAction` maps each to its one button:

| State | The card says | The button | The call |
|---|---|---|---|
| `not-installed` | Not installed, plus a line pointing at the snippets | none | — |
| `not-connected` | Not connected | Connect | `integrations.connect` |
| `connected` | Connected, with the registered command in mono | Disconnect | `integrations.disconnect` |
| `stale` | Another copy, with what it points at and why | Repair | `integrations.connect`, the same call |

**The snippets** — the universal fallback, in both shapes that exist: the
`mcpServers` JSON object and Codex's `[mcp_servers.witena]` table, each with a
Copy button. They are built from `launcherPath`, and they are shown **even when
it is `null`**, because a development checkout's endpoint works perfectly well
and it is only the *command* that has no stable spelling. The command is then
`node <witena-repo>/out/mcp-shim/witena-mcp.cjs`, with `<witena-repo>` left as a
placeholder that `settings.integrations.snippetDevNote` explains — the window
genuinely does not know where the checkout is, and a guessed path would be wrong
on every machine but one.

### Decisions worth keeping

- **The switch is driven from `status.endpoint.enabled`, not from the settings
  store.** `integrations.connect` enables the endpoint server-side before it
  registers anything (WP-11), so a switch reading `settings.mcpEndpoint.enabled`
  would sit at off after a successful Connect. The status the store holds answers
  both questions and arrives with every call.
- **The settings store is kept in step anyway.** It is the app-wide mirror of
  that row, so the toggle writes *through* it — `setMcpEndpoint`, the new sibling
  of `setEditor` and `setExecutor`, and the write that actually starts and stops
  the host — and a successful `connect` re-reads it. Two mirrors of one row that
  disagree are worse than one extra call on a click.
- **The snippets are data, not copy.** JSON, TOML and a filesystem path are the
  same in every language; a translated `mcpServers` key would be wrong in both.
  They are built by `integration-display.ts` with `JSON.stringify` and a TOML
  string escaper, so a bundle path containing a space or a quote survives the
  paste. The sentence *around* them goes through `t()` like everything else.
- **Every label is a key, including the two product names.**
  `settings.integrations.clientClaudeCode` is `Claude Code` in both locale files,
  which `locales.test.ts` allows for a value that is deliberately identical. It
  keeps the next client out of the JSX.
- **Labels are literal `t()` calls inside a `switch`**, the discipline
  `i18n/errors.ts` set: `t(KEYS[state])` is invisible to `used-keys.test.ts`, and
  a `switch` with no `default` makes the compiler prove the mapping is total.
- **The clipboard is not the backend.** `navigator.clipboard.writeText`, with the
  failure swallowed, exactly as `code-block.tsx` and `conclusion-card.tsx` do
  it — rule 6 is about reaching the *backend* past `BackendClient`, and the
  clipboard belongs to the window.

### Failures

The store keeps the trio every other store keeps — `error`, `errorCode`,
`errorDetails` — and the section draws it with `translateFailure`, so WP-11's two
`ValidationReason`s (`integrations_no_launcher`,
`integrations_client_not_installed`) become their own sentences with no mapping
of this section's own. A CLI that ran and refused arrives as `internal` with its
`stderr` in `message`: the generic sentence is the line, and the CLI's own words
are the dimmed monospace line under it, never in place of it.

Nothing in the store rejects. A refused Connect is a line under the cards.

### Tests

| File | What it owns |
|---|---|
| `components/settings/integration-display.test.ts` | Every state → label key, tone and action, including the absurd combination WP-11 never sends; the endpoint's three states; both snippets, their escaping and the development fallback |
| `stores/integrations.test.ts` | The three calls against a fake backend: Repair *is* `integrations.connect`; the toggle writes through the settings store and re-reads the status; a successful connect follows the row the handler flipped; `disconnect` leaves the endpoint alone; every refusal lands in the trio rather than rejecting |
| `e2e/integrations.spec.ts` | The section in the running app: a card per client, the switch publishing and removing the discovery file, and a snippet reaching the system clipboard |

**The e2e never presses Connect, Disconnect or Repair, and it is built so that it
cannot.** Those buttons run `claude mcp add` and `codex mcp remove`, which
rewrite `~/.claude.json` and `~/.codex/config.toml` — files belonging to whoever
is running the suite. The app is therefore launched with `WITENA_CLAUDE_BIN` and
`WITENA_CODEX_BIN` pointing at a path that does not exist: `resolveCliBinary`
returns an override without checking it, the `--version` probe fails, and both
cards render *not installed* on every machine with no action button on the screen
at all. The first test asserts that emptiness, which is both a check of the
not-installed state and the guard that keeps the file safe. Everything after a
button press is the two unit files' subject.
