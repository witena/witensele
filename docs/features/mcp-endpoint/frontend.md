# mcp-endpoint — Frontend

> Two surfaces so far: WP-8's deep-link handler and WP-13's provenance chip. The
> Settings section is still to come.

Surface, by work package (`tasks.md`):

| Surface | Package |
|---|---|
| Settings → Integrations: the endpoint switch, status, Claude Code and Codex cards, the generic snippet | WP-12 |
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
